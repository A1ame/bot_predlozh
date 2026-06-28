function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

async function safeSendHtml(bot, chatId, html, options = {}) {
  try {
    return await bot.sendMessage(chatId, html, { parse_mode: "HTML", ...options })
  } catch (error) {
    const description = error.response?.body?.description || error.message || ""
    if (!description.includes("can't parse entities")) throw error
    const plain = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<a href="([^"]+)">[^<]*<\/a>/gi, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
    return await bot.sendMessage(chatId, plain, { ...options, parse_mode: undefined })
  }
}

async function safeAnswerCallbackQuery(bot, queryId, options = {}) {
  try {
    await bot.answerCallbackQuery(queryId, options)
  } catch (error) {
    const description = error.response?.body?.description || error.message || ""
    if (
      description.includes("query is too old") ||
      description.includes("query ID is invalid")
    ) {
      return
    }
    throw error
  }
}

module.exports = { escapeHtml, safeAnswerCallbackQuery, safeSendHtml }
