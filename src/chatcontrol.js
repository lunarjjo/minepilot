'use strict'

// in-game chat control — baritone's prefix commands, ported. a chat line
// starting with the configured prefix (default "#") is a minepilot command;
// other lines are ignored. replies go back to chat with a recognizable tag
// (useMessageTag), the way baritone's chat feedback works.

const { executeCommand } = require('./commandexec')

function createChatControl (ctx) {
  const { bot, settings } = ctx
  const handler = (username, message) => {
    if (!settings.get('chatControl')) return
    if (username === bot.username) return // our own chat echoes back
    const prefix = settings.get('prefix')
    const needsPrefix = settings.get('prefixControl')
    let line = String(message == null ? '' : message).trim()
    if (needsPrefix) {
      if (!line.startsWith(prefix)) return
      line = line.slice(prefix.length).trim()
      if (line === '') return
    } else if (line.startsWith(prefix)) {
      line = line.slice(prefix.length).trim()
    }
    // the commander is whoever spoke (for #come)
    const commander = {
      name: username,
      entity: (bot.players && bot.players[username] && bot.players[username].entity) || null
    }
    const replies = []
    const reply = (text) => {
      replies.push(text)
      try {
        const tagged = settings.get('useMessageTag') ? `[minepilot] ${text}` : text
        bot.chat(tagged.slice(0, 256))
      } catch (e) { /* ignore */ }
    }
    executeCommand(line, { ...ctx, reply, source: 'chat', commander })
      .catch((e) => reply(`command error: ${String(e.message || e).slice(0, 80)}`))
  }
  bot.on('chat', handler)
  // whispers count too — baritone accepts /msg bot #stop
  if (bot.on) {
    bot.on('whisper', handler)
  }
  return {
    dispose () {
      bot.removeListener('chat', handler)
      try { bot.removeListener('whisper', handler) } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { createChatControl }
