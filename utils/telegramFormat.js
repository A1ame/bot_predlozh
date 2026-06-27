function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
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

module.exports = { escapeHtml, safeAnswerCallbackQuery }
