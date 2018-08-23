const which = require('which')
const fs = require('fs')

module.exports.binary = () => {
  const lookups = {
    linux: () => linux(['google-chrome', 'google-chrome-stable']),
    win32: () => win32(),
    darwin: () => darwin('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  }

  if (lookups[process.platform]) {
    return lookups[process.platform]()
  }

  throw new Error('Unknown arch %s', arch)
}

module.exports.options = (datadir, headless, uri) => {
  return [
    headless ? '--headless' : '',
    `--user-data-dir=${datadir}`,
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-translate',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-device-discovery-notifications',
    '--remote-debugging-port=0',
    uri
  ]
}

function linux(commands) {
  let bin

  for (let command of commands) {
    try {
      if (which.sync(command)) {
        return command
      }
    } catch (e) {}
  }
}

function win32() {
  const suffix = `\\Google\\Chrome\\Application\\chrome.exe`
  const prefixes = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]

  for (let prefix of prefixes) {
    try {
      let path = path.join(prefix, suffix)
      fs.accessSync(path)
      return path
    } catch (e) {}
  }
}

function darwin(defaultPath) {
  try {
    let path = path.join(process.env.HOME, defaultPath)
    fs.accessSync(path)
    return path
  } catch (e) {
    return defaultPath
  }
}
