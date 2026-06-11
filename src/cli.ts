#!/usr/bin/env node
import { cliMain } from './commands.js'

// node:sqlite is stable in behavior but still flagged experimental; its
// warning on every invocation is pure noise for CLI users. Re-emit every
// other warning unchanged.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return
  console.error(`${warning.name}: ${warning.message}`)
})

process.exitCode = await cliMain(process.argv.slice(2), { stdin: 'inherit' })
