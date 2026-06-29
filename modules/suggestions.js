const db = require("../database/database")
const keyboards = require("../utils/keyboards")
const logger = require("../utils/logger")
const config = require("../config/config")
const { escapeHtml, safeAnswerCallbackQuery, safeSendHtml } = require("../utils/telegramFormat")

class SuggestionsManager {
    constructor(bot, vkBridges = null) {
        this.bot = bot
        // Принимаем как массив bridges, так и одиночный bridge (обратная совместимость)
        if (Array.isArray(vkBridges)) {
            this.vkBridges = vkBridges
            this.vkBridge = vkBridges[0] || null  // первый = основной для обратной совместимости
        } else {
            this.vkBridges = vkBridges ? [vkBridges] : []
            this.vkBridge = vkBridges || null
        }
        this.userStates = new Map()
        this.mediaGroupCache = new Map()
        this.cancelMessages = new Map()
        this.lastUserChannels = new Map() // Храним последний выбранный канал для каждого пользователя
        
        // ИСПРАВЛЕНИЕ: Мьютекс/Лок в памяти для предотвращения одновременной обработки (защита от двойного клика)
        this.processingSuggestions = new Set() 
    }

    // ─────────────────────────────────────────────
    // Блокировка пересылки одобренного поста в ВК через channel_post.
    // ─────────────────────────────────────────────
    _blockApprovalFromVkForward(chatId, sentResult) {
        if (!sentResult || !this.vkBridges.length) return
        const msgs = Array.isArray(sentResult) ? sentResult : [sentResult]
        for (const bridge of this.vkBridges) {
            for (const msg of msgs) {
                if (msg && msg.message_id) {
                    const key = `tg_${chatId}_${msg.message_id}`
                    bridge.processedTgPosts.add(key)
                    setTimeout(() => bridge.processedTgPosts.delete(key), 120000)
                    logger.info(`_blockApprovalFromVkForward: blocked key=${key}`)
                }
            }
            // Для медиагрупп блокируем ещё и по media_group_id
            const withGroup = msgs.find(m => m && m.media_group_id)
            if (withGroup) {
                const key = `tg_${chatId}_group_${withGroup.media_group_id}`
                bridge.processedTgPosts.add(key)
                setTimeout(() => bridge.processedTgPosts.delete(key), 120000)
                logger.info(`_blockApprovalFromVkForward: blocked media_group key=${key}`)
            }
        }
    }

    // ИСПРАВЛЕНИЕ: Полное восстановление метода handleForwardToMainAdmin без заглушек
    async handleForwardToMainAdmin(callbackQuery) {
        try {
            const data = callbackQuery.data;
            const parts = data.split("_");
            const suggestionId = parts[4]; 

            const suggestion = await db.getSuggestion(suggestionId);

            if (!suggestion) {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" });
                return;
            }

            // Отправляем сообщение пользователю
            try {
                await this.bot.sendMessage(
                    suggestion.user_id,
                    "По этому вопросу обращайтесь к главному админу @ktozachemi",
                    { reply_to_message_id: suggestion.original_message_id }
                );
            } catch (error) {
                await this.bot.sendMessage(
                    suggestion.user_id,
                    "По этому вопросу обращайтесь к главному админу @ktozachemi"
                );
            }

            // Обновляем статус в базе данных
            await db.updateSuggestionStatus(suggestionId, "forwarded");

            // Обновляем статус в админском чате
            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "➡️ ОТПРАВЛЕНО К ГЛАВНОМУ АДМИНУ", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Пользователь направлен к главному админу!" });
        } catch (error) {
            logger.error("Error forwarding to main admin:", error);
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при выполнении действия" });
        }
    }

    async handleStartForSuggestions(msg, channelId) {
        try {
            const userId = msg.from.id
            const chatId = msg.chat.id
            const fullChannelId = `-${channelId}`

            const channels = await db.getChannels()
            const channel = channels.find((ch) => {
                if (ch.chat_id === fullChannelId) return true
                return Math.abs(Number(ch.chat_id)).toString() === channelId
            })

            if (!channel || !channel.suggestions_enabled) {
                await this.bot.sendMessage(chatId, "❌ Канал не найден или предложения отключены.")
                return
            }

            this.lastUserChannels.set(userId, channel.chat_id)
            this.userStates.set(userId, {
                action: "waiting_suggestion",
                targetChannelId: channel.chat_id,
                chatId: chatId,
            })

            const channelLabel = escapeHtml(channel.title || channel.username)
            const sentMessage = await this.bot.sendMessage(
                chatId,
                `📝 <b>Предложить контент в канал</b>\n\n` +
                `📍 Вы отправляете сообщение в канал <b>${channelLabel}</b>\n\n` +
                `⚠️ Ваше предложение будет отправлено на модерацию администраторам.\n\n` +
                `Теперь вы можете просто отправлять сообщения — они будут автоматически направляться в этот канал.\n` +
                `Используйте /mysuggest чтобы изменить канал или посмотреть текущий.\n\n` +
                `created by • <a href="https://t.me/wwhyumadbro">elscripts</a>`,
                {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "❌ Отменить", callback_data: "cancel_suggestion" }],
                        ],
                    },
                },
            )
            this.cancelMessages.set(userId, sentMessage.message_id)
        } catch (error) {
            logger.error("Error handling start for suggestions:", error)
        }
    }

    async handleMySuggestCommand(msg) {
        try {
            const userId = msg.from.id
            const lastChannelId = this.lastUserChannels.get(userId)

            if (!lastChannelId) {
                await this.bot.sendMessage(
                    msg.chat.id,
                    "🤔 Вы еще не выбирали канал для предложений.\n\n" +
                    "Используйте ссылку из канала, куда хотите предложить контент, или попросите администратора предоставить ссылку."
                )
                return
            }

            const channels = await db.getChannels()
            const channel = channels.find((ch) => {
                if (ch.chat_id === lastChannelId) return true
                const clean = ch.chat_id.startsWith("-") ? ch.chat_id.slice(1) : ch.chat_id
                const lastClean = lastChannelId.startsWith("-") ? lastChannelId.slice(1) : lastChannelId
                return clean === lastClean
            })

            if (!channel) {
                await this.bot.sendMessage(msg.chat.id, "❌ Канал не найден. Используйте новую ссылку.")
                this.lastUserChannels.delete(userId)
                return
            }

            const botInfo = await this.bot.getMe()
            const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
            const suggestLink = `https://t.me/${botInfo.username}?start=${cleanChannelId}_channel`

            const channelLabel = escapeHtml(channel.title || channel.username)
            const channelLink = escapeHtml(channel.username || `ID: ${cleanChannelId}`)
            await safeSendHtml(
                this.bot,
                msg.chat.id,
                `📋 <b>Текущий канал для предложений:</b>\n\n` +
                `📍 ${channelLabel}\n` +
                `🔗 ${channelLink}\n\n` +
                `✏️ Просто отправляйте сообщения — они будут автоматически направляться в этот канал.\n\n` +
                `🔄 Чтобы изменить канал, используйте другую ссылку:\n` +
                `<a href="${suggestLink}">${escapeHtml(suggestLink)}</a>\n\n` +
                `📝 Или попросите администратора предоставить ссылку для другого канала.`,
                { disable_web_page_preview: true },
            )
        } catch (error) {
            logger.error("Error handling /mysuggest command:", error)
        }
    }

    async handlePrivateSuggestion(msg) {
        try {
            const userId = msg.from.id

            const isBanned = await db.isUserBanned(userId)
            if (isBanned) {
                await this.bot.sendMessage(msg.chat.id, "🚫 Вы заблокированы и не можете отправлять предложения.")
                return
            }

            const lastChannelId = this.lastUserChannels.get(userId)

            if (lastChannelId) {
                const channels = await db.getChannels()
                const channel = channels.find((ch) => ch.chat_id === lastChannelId)

                if (channel && channel.suggestions_enabled) {
                    this.userStates.set(userId, {
                        action: "waiting_suggestion",
                        targetChannelId: lastChannelId,
                        chatId: msg.chat.id,
                    })
                }
            }

            const userState = this.userStates.get(userId)
            if (!userState || userState.action !== "waiting_suggestion") {
                if (!lastChannelId) {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "🤔 Сначала выберите канал для предложений!\n\n" +
                        "Используйте ссылку из канала, куда хотите предложить контент, или попросите администратора предоставить ссылку.\n\n" +
                        "Пример ссылки: https://t.me/YourBotName?start=12345_channel"
                    )
                } else if (msg.text && msg.text.startsWith("/")) {
                    return
                } else if (msg.text && /^@[a-zA-Z0-9_]{4,32}$/.test(msg.text.trim())) {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "ℹ️ Чтобы добавить канал, откройте админ-панель (/admin) и нажмите «Добавить канал».",
                    )
                } else {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "ℹ️ Чтобы отправить предложение, сначала откройте ссылку предложки из нужного канала.",
                    )
                }
                return
            }

            const username = msg.from.username || msg.from.first_name
            const targetChannelId = userState.targetChannelId
            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === targetChannelId)

            if (!channel) {
                await this.bot.sendMessage(msg.chat.id, "❌ Канал не найден. Используйте новую ссылку.")
                this.userStates.delete(userId)
                this.lastUserChannels.delete(userId)
                return
            }

            if (msg.media_group_id) {
                if (!this.mediaGroupCache.has(msg.media_group_id)) {
                    this.mediaGroupCache.set(msg.media_group_id, {
                        userId, username, chatId: msg.chat.id, channel, messages: [], timer: null,
                    })
                }
                const groupData = this.mediaGroupCache.get(msg.media_group_id)
                groupData.messages.push(msg)
                this._queueAlbumProcessing(msg.media_group_id, groupData, true)
                return
            }

            await this._forwardPrivateSingleSuggestion(msg, userId, username, channel)
            this.userStates.delete(userId)
        } catch (error) {
            logger.error("Error handling private suggestion:", error)
        }
    }

    async handleSuggestion(msg) {
        try {
            const userId = msg.from.id
            const username = msg.from.username || msg.from.first_name
            const chatId = msg.chat.id.toString()

            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === chatId && ch.suggestions_enabled)
            if (!channel) return

            if (msg.media_group_id) {
                if (!this.mediaGroupCache.has(msg.media_group_id)) {
                    this.mediaGroupCache.set(msg.media_group_id, {
                        userId, username, chatId, channel, messages: [], timer: null,
                    })
                }
                const groupData = this.mediaGroupCache.get(msg.media_group_id)
                groupData.messages.push(msg)
                this._queueAlbumProcessing(msg.media_group_id, groupData, false)
                return
            }

            await this._forwardSingleSuggestion(msg, userId, username, chatId, channel)
        } catch (error) {
            logger.error("Error handling suggestion:", error)
        }
    }

    _getContentType(msg) {
        if (msg.photo) return "photo"
        if (msg.video) return "video"
        if (msg.document) return "document"
        if (msg.audio) return "audio"
        if (msg.voice) return "voice"
        if (msg.sticker) return "sticker"
        if (msg.animation) return "animation"
        return "text"
    }

    async _forwardSingleSuggestion(msg, userId, username, chatId, channel) {
        const contentType = this._getContentType(msg)
        if (msg.text === "/start") return

        const suggestionId = await db.addSuggestion(
            userId,
            username,
            chatId,
            msg.message_id,
            contentType,
            null,
            null,
            msg.text || msg.caption || null,
        );

        const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
        const replyMarkup = keyboards.suggestionActions(suggestionId, cleanChannelId).reply_markup

        if (contentType === "text") {
            const adminMessage = await this.bot.sendMessage(
                config.adminChatId,
                `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.text}`,
                { reply_markup: replyMarkup }
            )
            await db.updateSuggestionStatus(suggestionId, "pending", adminMessage.message_id)
        } else {
            const adminMessage = await this.bot.copyMessage(
                config.adminChatId,
                chatId,
                msg.message_id,
                {
                    caption: `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.caption || ""}`,
                    reply_markup: replyMarkup
                }
            )
            await db.updateSuggestionStatus(suggestionId, "pending", adminMessage.message_id)
        }

        this.userStates.delete(userId)
        const cancelMessageId = this.cancelMessages.get(userId)
        if (cancelMessageId) {
            try { await this.bot.deleteMessage(msg.chat.id, cancelMessageId) } catch (error) {}
            this.cancelMessages.delete(userId)
        }

        await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!", {
            reply_to_message_id: msg.message_id
        });
    }

    async _forwardPrivateSingleSuggestion(msg, userId, username, channel) {
        const contentType = this._getContentType(msg)
        if (msg.text === "/start" || msg.text === "/mysuggest") return

        const suggestionId = await db.addSuggestion(
            userId,
            username,
            channel.chat_id,
            msg.message_id,
            contentType,
            msg.chat.id,
            null,
            msg.text || msg.caption || null
        )

        const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
        const replyMarkup = keyboards.suggestionActions(suggestionId, cleanChannelId).reply_markup

        if (contentType === "text") {
            const adminMessage = await this.bot.sendMessage(
                config.adminChatId,
                `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.text}`,
                { reply_markup: replyMarkup }
            )
            await db.updateSuggestionWithMessageInfo(suggestionId, "pending", adminMessage.message_id, msg.chat.id, msg.message_id)
        } else {
            const adminMessage = await this.bot.copyMessage(config.adminChatId, msg.chat.id, msg.message_id, {
                caption: `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.caption || ""}`,
                reply_markup: replyMarkup
            })
            await db.updateSuggestionWithMessageInfo(suggestionId, "pending", adminMessage.message_id, msg.chat.id, msg.message_id)
        }

        const cancelMessageId = this.cancelMessages.get(userId)
        if (cancelMessageId) {
            try { await this.bot.deleteMessage(msg.chat.id, cancelMessageId) } catch (error) {}
            this.cancelMessages.delete(userId)
        }

        try {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!", {
                reply_to_message_id: msg.message_id
            });
        } catch(error) {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!");
        }
    }

    async handleCancelSuggestion(callbackQuery) {
        try {
            const userId = callbackQuery.from.id
            const chatId = callbackQuery.message.chat.id

            this.userStates.delete(userId)

            const cancelMessageId = this.cancelMessages.get(userId)
            if (cancelMessageId) {
                try { await this.bot.deleteMessage(chatId, cancelMessageId) } catch (error) {}
                this.cancelMessages.delete(userId)
            }
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение отменено" })
        } catch (error) {
            logger.error("Error handling cancel suggestion:", error)
        }
    }

    _sortAlbumMessages(messages) {
        return [...messages].sort((a, b) => a.message_id - b.message_id)
    }

    _getAlbumCaption(messages) {
        return this._sortAlbumMessages(messages)
            .map((m) => m.caption || m.text || "")
            .find((text) => text.trim()) || ""
    }

    _queueAlbumProcessing(mediaGroupId, groupData, isPrivate) {
        if (groupData.timer) clearTimeout(groupData.timer)
        groupData.timer = setTimeout(async () => {
            const cached = this.mediaGroupCache.get(mediaGroupId)
            if (!cached) return
            await this._forwardAlbum(cached, isPrivate)
            this.mediaGroupCache.delete(mediaGroupId)
        }, 3000)
    }

    _messageToAlbumMedia(msg) {
        if (msg.photo) return { type: "photo", media: msg.photo[msg.photo.length - 1].file_id }
        if (msg.video) return { type: "video", media: msg.video.file_id }
        if (msg.animation) return { type: "video", media: msg.animation.file_id }
        if (msg.document && msg.document.mime_type) {
            if (msg.document.mime_type.startsWith("video/")) return { type: "video", media: msg.document.file_id }
            if (msg.document.mime_type.startsWith("image/")) return { type: "photo", media: msg.document.file_id }
        }
        return null
    }

    _buildInputMediaList(parsedMedia, caption, parseMode) {
        const CAPTION_MAX = 1024
        let cap = caption || ""
        if (cap.length > CAPTION_MAX) cap = cap.slice(0, CAPTION_MAX - 3) + "..."

        return parsedMedia.map((item, idx) => {
            const entry = { type: item.type, media: item.media }
            if (idx === 0 && cap) {
                entry.caption = cap
                if (parseMode) entry.parse_mode = parseMode
            }
            if (item.type === "video") entry.supports_streaming = true
            return entry
        })
    }

    async _sendAlbumToChannel(chatId, parsedMedia, caption, options = {}) {
        const { guideText = "", guideParseMode = "HTML", parseMode = null } = options
        const CAPTION_MAX = 1024
        const userCaption = caption || ""

        if (guideText && userCaption.length + guideText.length > CAPTION_MAX) {
            const media = this._buildInputMediaList(parsedMedia, userCaption, parseMode)
            const sent = await this.bot.sendMediaGroup(chatId, media)
            const guideMsg = await this.bot.sendMessage(chatId, guideText, {
                parse_mode: guideParseMode,
                disable_web_page_preview: true,
            })
            return [...sent, guideMsg]
        }

        const fullCaption = guideText ? userCaption + guideText : userCaption
        const media = this._buildInputMediaList(
            parsedMedia,
            fullCaption,
            guideText ? guideParseMode : parseMode,
        )
        return await this.bot.sendMediaGroup(chatId, media)
    }

    async _forwardAlbum(groupData, isPrivate = false) {
        const { userId, username, chatId, channel, messages } = groupData
        const sortedMessages = this._sortAlbumMessages(messages)

        const media = sortedMessages.map((m) => this._messageToAlbumMedia(m)).filter(Boolean)
        if (media.length === 0) {
            logger.warn("_forwardAlbum: no supported media in album")
            return
        }

        const userText = this._getAlbumCaption(sortedMessages)
        const fileIdsWithType = media.map((m) => m.type + ":" + m.media)

        const suggestionId = await db.addSuggestion(
            userId,
            username,
            channel.chat_id,
            sortedMessages[0].message_id,
            "album",
            isPrivate ? chatId : null,
            fileIdsWithType,
            userText
        )

        const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
        const replyMarkup = keyboards.suggestionActions(suggestionId, cleanChannelId).reply_markup

        const adminGroup = await this.bot.sendMediaGroup(
            config.adminChatId,
            media.map((m, idx) => ({
                ...m,
                caption: idx === 0 ? userText : undefined
            }))
        )

        const adminControls = await this.bot.sendMessage(
            config.adminChatId,
            `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${userText}`,
            {
                reply_to_message_id: adminGroup[0].message_id,
                reply_markup: replyMarkup
            }
        )

        await db.updateSuggestionWithMessageInfo(
            suggestionId,
            "pending",
            adminControls.message_id,
            chatId,
            sortedMessages[0].message_id
        )

        try {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!", {
                reply_to_message_id: sortedMessages[0].message_id
            });
        } catch(error) {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!");
        }
    }

    // ИСПРАВЛЕНИЕ: Полный рефакторинг роутера инлайн-кликов с устранением багов и локов дублирования
    async handleSuggestionAction(callbackQuery) {
        try {
            const data = callbackQuery.data;
            console.log("Callback data received:", data);

            if (data === "noop") {
                await this.bot.answerCallbackQuery(callbackQuery.id);
                return;
            }

            // ИСПРАВЛЕНИЕ: Выносим обработку разбана вверх, чтобы регулярные сплиты не ломали логику
            if (data.startsWith("unban_bot_")) {
                const targetUserId = data.split("_")[2];
                if (db.unbanUser) {
                    await db.unbanUser(targetUserId);
                }
                await this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [[{ text: "🔓 АВТОР РАЗБАНЕН", callback_data: "noop" }]] },
                    { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
                );
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Пользователь разбанен в боте!" });
                return;
            }

            const channels = await db.getChannels();
            let suggestionId = null;
            let action = null;
            let channelIdFromButton = null;

            // Точный разбор callback данных
            if (data.startsWith("approve_guide_")) {
                const parts = data.split("_");
                suggestionId = parts[2];
                channelIdFromButton = parts[3];
                action = "approve_guide";
            } else if (data.startsWith("forward_to_main_admin_")) {
                const parts = data.split("_");
                suggestionId = parts[4];
                action = "forward_to_main_admin";
            } else {
                const parts = data.split("_");
                action = parts[0];
                suggestionId = parts[1];
            }

            if (!suggestionId) return;

            // ИСПРАВЛЕНИЕ: Защита от дребезга / двойного клика (In-Memory Lock)
            if (this.processingSuggestions.has(suggestionId)) {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "⏳ Запрос уже обрабатывается, подождите..." });
                return;
            }

            const suggestion = await db.getSuggestion(suggestionId);
            if (!suggestion) {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" });
                return;
            }

            // ИСПРАВЛЕНИЕ: Проверка статуса (если пост уже одобрен/отклонен, не шлем дубль)
            if (suggestion.status !== "pending") {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: `Действие отменено. Статус поста уже: ${suggestion.status}` });
                
                let label = "ОБРАБОТАНО";
                if (suggestion.status === "approved") label = "✅ УЖЕ ОДОБРЕНО";
                if (suggestion.status === "rejected") label = "❌ УЖЕ ОТКЛОНЕНО";
                if (suggestion.status === "banned") label = "🚫 АВТОР В БАНЕ";

                try {
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [[{ text: label, callback_data: "noop" }]] },
                        { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
                    );
                } catch (e) {}
                return;
            }

            // Активируем лок на время выполнения
            this.processingSuggestions.add(suggestionId);

            try {
                if (action === "approve_guide") {
                    const channel = channels.find(ch => {
                        const chId = ch.chat_id.startsWith('-') ? ch.chat_id.slice(1) : ch.chat_id;
                        return chId === channelIdFromButton;
                    });
                    if (!channel) {
                        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Канал не найден!" });
                        return;
                    }
                    await this.approveSuggestionWithGuide(suggestion, channel, callbackQuery);
                    return;
                }

                if (action === "forward_to_main_admin") {
                    await this.handleForwardToMainAdmin(callbackQuery);
                    return;
                }

                const channel = channels.find(ch => {
                    const chId = ch.chat_id.startsWith('-') ? ch.chat_id.slice(1) : ch.chat_id;
                    const sugId = suggestion.chat_id.startsWith('-') ? suggestion.chat_id.slice(1) : suggestion.chat_id;
                    return chId === sugId;
                });

                if (!channel && (action === "approve" || action === "ban")) {
                    await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Целевой канал не найден в БД!" });
                    return;
                }

                switch (action) {
                    case "approve":
                        await this.approveSuggestion(suggestion, channel, callbackQuery);
                        break;
                    case "rejected": // Поддержка вариаций именования кнопок
                    case "reject":
                        await this.rejectSuggestion(suggestion, callbackQuery);
                        break;
                    case "ban":
                        await this.banSuggestionAuthor(suggestion, channel, callbackQuery);
                        break;
                    default:
                        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Неизвестное действие кнопки" });
                }
            } finally {
                // ИСПРАВЛЕНИЕ: Обязательно снимаем лок при любом результате
                this.processingSuggestions.delete(suggestionId);
            }
        } catch (error) {
            console.error("Error handling suggestion action:", error);
            await safeAnswerCallbackQuery(this.bot, callbackQuery.id, { text: "Произошла критическая ошибка" });
        }
    }

    // ИСПРАВЛЕНИЕ: Умная маршрутизация в ВК без слепого дублирования во все паблики
    async _postSuggestionToVk(suggestion, extraText = "") {
        if (!this.vkBridges || this.vkBridges.length === 0) return
        try {
            let bridge = null
            if (suggestion.chat_id) {
                const channels = await db.getChannels()
                const channel = channels.find(ch => {
                    const chId = ch.chat_id.startsWith('-') ? ch.chat_id.slice(1) : ch.chat_id
                    const sugId = suggestion.chat_id.startsWith('-') ? suggestion.chat_id.slice(1) : suggestion.chat_id
                    return chId === sugId
                })
                if (channel && channel.vk_group_id) {
                    const matched = this.vkBridges.find(b => String(b.vkGroupId) === String(channel.vk_group_id))
                    if (matched) {
                        bridge = matched
                        logger.info(`_postSuggestionToVk: routing suggestion #${suggestion.id} to VK group ${bridge.vkGroupId}`)
                    } else {
                        logger.warn(`_postSuggestionToVk: no VK bridge found for group ${channel.vk_group_id}`)
                    }
                } else {
                    logger.info(`_postSuggestionToVk: Канал ${suggestion.chat_id} не привязан к ВК. Кросс-постинг отменен.`);
                }
            }

            // Корректный fallback: если мостов несколько, не спамим в первый попавшийся наугад
            if (!bridge) {
                if (this.vkBridges.length === 1) {
                    bridge = this.vkBridges[0];
                } else {
                    logger.warn(`_postSuggestionToVk: Не удалось определить целевую группу ВК для поста #${suggestion.id}. Публикация отменена во избежание спама.`);
                    return;
                }
            }

            const text = (suggestion.caption || "") + (extraText ? "\n\n" + extraText : "")
            const photoBuffers = []

            if (suggestion.content_type === "album" && suggestion.file_ids) {
                const parsedMedia = this._parseFileIds(suggestion.file_ids)
                for (const item of parsedMedia) {
                    try {
                        const fileInfo = await this.bot.getFile(item.media)
                        const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
                        const buffer = await bridge.downloadFile(fileUrl)
                        if (!buffer || buffer.length < 128) {
                            logger.warn(`_postSuggestionToVk: skip tiny buffer for ${item.media}`)
                            continue
                        }
                        const isVideo = item.type === "video"
                        const extMatch = fileInfo.file_path && fileInfo.file_path.match(/\.[a-z0-9]+$/i)
                        const ext = extMatch ? extMatch[0] : (isVideo ? ".mp4" : ".jpg")
                        photoBuffers.push({
                            buffer,
                            filename: isVideo ? `video${ext}` : `photo${ext}`,
                            type: item.type,
                        })
                    } catch (e) {
                        logger.error("_postSuggestionToVk: error downloading album media:", e)
                    }
                }
            } else if (suggestion.content_type === "photo" && suggestion.original_message_id && suggestion.original_chat_id) {
                try {
                    const fwd = await this.bot.forwardMessage(config.adminChatId, suggestion.original_chat_id, suggestion.original_message_id)
                    if (fwd.photo) {
                        const photo = fwd.photo[fwd.photo.length - 1]
                        const fileInfo = await this.bot.getFile(photo.file_id)
                        const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
                        const buffer = await bridge.downloadFile(fileUrl)
                        photoBuffers.push({ buffer, filename: "photo.jpg" })
                        try { await this.bot.deleteMessage(config.adminChatId, fwd.message_id) } catch(e) {}
                    }
                } catch (e) {
                    logger.error("_postSuggestionToVk: error forwarding photo:", e)
                }
            }

            const dedupeKey = `suggest_approved_${suggestion.id}`
            await bridge.postToVk(text, photoBuffers, dedupeKey)
            logger.info(`Suggestion #${suggestion.id} posted to VK`)
        } catch (error) {
            logger.error("_postSuggestionToVk error:", error)
        }
    }

    _parseFileIds(fileIds) {
        if (!fileIds || !Array.isArray(fileIds)) return []
        return fileIds.map(f => {
            if (typeof f === "string" && (f.startsWith("photo:") || f.startsWith("video:"))) {
                const [type, ...rest] = f.split(":")
                return { type, media: rest.join(":") }
            }
            return { type: "photo", media: f }
        })
    }

    async approveSuggestionWithGuide(suggestion, channel, callbackQuery) {
        try {
            await safeAnswerCallbackQuery(this.bot, callbackQuery.id, { text: "Одобряю с гайдом..." })
            const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id;
            const suggestLink = `https://t.me/${config.botName}?start=${cleanChannelId}_channel`;

            const tgGuide = `\n\n📒 Хочешь чтобы твое сообщение попало в канал, пиши <a href="${suggestLink}">сюда</a>\n Эту ссылку так же можно найти в описании канала`;
            const userCaption = escapeHtml(suggestion.caption || "")
            const vkGuide = `Если ты хочешь, чтобы новость попала в Подслушку, пролистай вверх и нажми на кнопку "Предложить новость"`;

            let sentResult = null

            if (suggestion.content_type === "album" && suggestion.file_ids) {
                const parsedMedia = this._parseFileIds(suggestion.file_ids)
                sentResult = await this._sendAlbumToChannel(suggestion.chat_id, parsedMedia, userCaption, {
                    guideText: tgGuide,
                    guideParseMode: "HTML",
                })
            } else if (suggestion.content_type === "text") {
                sentResult = await this.bot.sendMessage(
                    suggestion.chat_id,
                    userCaption + tgGuide,
                    { parse_mode: "HTML", disable_web_page_preview: true },
                )
            } else {
                sentResult = await this.bot.copyMessage(
                    suggestion.chat_id,
                    suggestion.original_chat_id,
                    suggestion.original_message_id,
                    { caption: userCaption + tgGuide, parse_mode: "HTML" }
                );
            }

            this._blockApprovalFromVkForward(suggestion.chat_id, sentResult)
            await db.updateSuggestionStatus(suggestion.id, "approved");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "✅ ОДОБРЕНО С ГАЙДОМ", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            ).catch(() => {})

            try {
                await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!", {
                    reply_to_message_id: suggestion.original_message_id
                });
            } catch(error) {
                try { await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!"); } catch(e) {}
            }

            await this._postSuggestionToVk(suggestion, vkGuide)
        } catch (error) {
            console.error("Error approving suggestion with guide:", error);
        }
    }

    async approveSuggestion(suggestion, channel, callbackQuery) {
        try {
            await safeAnswerCallbackQuery(this.bot, callbackQuery.id, { text: "Одобряю..." })
            let sentResult = null

            if (suggestion.content_type === "album" && suggestion.file_ids) {
                const parsedMedia = this._parseFileIds(suggestion.file_ids)
                sentResult = await this._sendAlbumToChannel(
                    suggestion.chat_id,
                    parsedMedia,
                    suggestion.caption || "",
                )
            } else if (suggestion.content_type === "text") {
                sentResult = await this.bot.sendMessage(suggestion.chat_id, suggestion.caption || "");
            } else {
                sentResult = await this.bot.copyMessage(
                    suggestion.chat_id,
                    suggestion.original_chat_id,
                    suggestion.original_message_id,
                    { caption: suggestion.caption || "" }
                );
            }

            this._blockApprovalFromVkForward(suggestion.chat_id, sentResult)
            await db.updateSuggestionStatus(suggestion.id, "approved");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "✅ ОДОБРЕНО", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            ).catch(() => {})

            try {
                await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!", {
                    reply_to_message_id: suggestion.original_message_id
                });
            } catch(error) {
                try { await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!"); } catch(e) {}
            }

            await this._postSuggestionToVk(suggestion)
        } catch (error) {
            logger.error("Error approving suggestion:", error);
        }
    }

    async rejectSuggestion(suggestion, callbackQuery) {
        try {
            await safeAnswerCallbackQuery(this.bot, callbackQuery.id, { text: "Отклоняю..." })
            await db.updateSuggestionStatus(suggestion.id, "rejected");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "❌ ОТКЛОНЕНО", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            ).catch(() => {})

            try {
                await this.bot.sendMessage(suggestion.user_id, "❌ Ваше предложение было отклонено администрацией.", {
                    reply_to_message_id: suggestion.original_message_id
                });
            } catch(error) {
                try { await this.bot.sendMessage(suggestion.user_id, "❌ Ваше предложение было отклонено администрацией."); } catch(e) {}
            }

        } catch (error) {
            logger.error("Error rejecting suggestion:", error);
        }
    }

    async banSuggestionAuthor(suggestion, channel, callbackQuery) {
        try {
            await safeAnswerCallbackQuery(this.bot, callbackQuery.id, { text: "Баню автора..." })
            const usernameToSave = suggestion.username ? suggestion.username.replace("@", "").toLowerCase() : null
            await db.banUser(suggestion.user_id, usernameToSave);
            await db.updateSuggestionStatus(suggestion.id, "banned");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "🚫 АВТОР ЗАБАНЕН В БОТЕ", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            try {
                await this.bot.sendMessage(
                    suggestion.user_id,
                    `🚫 Вы заблокированы и больше не можете отправлять предложения.`
                );
            } catch (error) { /* Пользователь мог заблокировать бота */ }

            try {
                await this.bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: [[
                            { text: "🚫 АВТОР ЗАБАНЕН В БОТЕ", callback_data: "noop" },
                            { text: "🔓 Разбанить", callback_data: `unban_bot_${suggestion.user_id}` }
                        ]]
                    },
                    { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
                )
            } catch (e) {}

        } catch (error) {
            logger.error("Error banning suggestion author:", error);
        }
    }
}

module.exports = SuggestionsManager
