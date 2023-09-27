#!/usr/bin/env node
//
// DOM XSS Scanner
// (c) Lauritz Holtmann, 2023
//

const fs = require('fs')
const yargs = require('yargs')
const pt = require('puppeteer')
const process = require('process')
const readline = require('readline')
let payloads = require('./payloads.json')

// ASCII Art
const art = `\x1b[96m
     _                                     
  __| | ___  _ __ ___  ___  ___ __ _ _ __  
 / _\` |/ _ \\| '_ \` _ \\/ __|/ __/ _\` | '_ \\ 
| (_| | (_) | | | | | \\__ \\ (_| (_| | | | |
 \\__,_|\\___/|_| |_| |_|___/\\___\\__,_|_| |_|
             
 (C) Lauritz Holtmann, 2023
 \x1b[0m`
console.log(art)

// Define the command-line interface
const argv = yargs
  .version('v0.0.4')
  .option('verbose', {
    alias: 'v',
    describe: 'Enable verbose output',
    type: 'boolean'
  })
  .option('headless', {
    default: true,
    describe: 'Open browser in headless mode',
    type: 'boolean'
  })
  .option('guessParameters', {
    alias: 'g',
    describe: 'Enable parameter guessing based on URLSearchParams and input field names',
    type: 'boolean'
  })
  .option('throttle', {
    alias: 't',
    describe: 'Throttle connection to 1 MBit/s',
    type: 'boolean'
  })
  .option('guessParametersExtended', {
    alias: 'G',
    describe: 'Enable extended parameter guessing based on variable definition in JS code and wordlist',
    type: 'boolean'
  })
  .option('userAgent', {
    alias: 'u',
    describe: 'Specify user agent',
    type: 'string'
  })
  .option('excludeFromConsole', {
    describe: 'Ignore String within Console Messages',
    type: 'string',
    array: true
  })
  .option('proxy', {
    alias: 'p',
    describe: 'Specify HTTP proxy (also disables certificate validation)',
    type: 'string'
  })
  .option('cookie', {
    alias: 'c',
    describe: 'Specify cookies (multiple values allowed)',
    array: true
  })
  .option('interactive', {
    alias: 'i',
    describe: 'Pause on each payload and wait for user input',
    type: 'boolean'
  })

  .option('excludedParameter', {
    describe: 'Exclude parameter from scan (multiple values allowed)',
    array: true
  })
  .option('localStorage', {
    alias: 'l',
    describe: 'Specify localStorage entries (multiple values allowed)',
    array: true
  })
  .option('manualLogin', {
    alias: 'm',
    describe: 'Launch an interactive Browser Session prior Scan which enables to manually perform bootstrapping such as logging in, requires "--headless false"',
    type: 'boolean'
  })
  .option('nosandbox', {
    alias: '-no-sandbox',
    default: false,
    describe: 'Launch Chromium without sandbox',
    type: 'boolean'
  })

  .demandCommand(1, 'Please provide a URL.')
  .help()
  .alias('help', 'h')
  .argv

// Global variables
const url = new URL(argv._[0])
const marker = Math.random().toString(32).substring(2, 10)
payloads = payloads.map(payload => payload.replace('MARKER', marker))

const parameters = {}
const fragmentParameters = {}
let guessedParameters = []

const initialPageLoadConsoleMessages = []
const initialPageLoadRequestfailed = []
const initialPageLoadPageErrors = []
const findings = {}
let currentUrl = url
let currentPayload = ''
let currentParameter = ''
let redirectedForParameter = false

// Helper functions
function parseUrlParameters () {
  if (url.searchParams.entries().next().value !== undefined) {
    for (const [key, value] of url.searchParams.entries()) {
      if (parameters[key] === undefined) {
        parameters[key] = value
      } else if (Array.isArray(parameters[key]) === false) {
        parameters[key] = [parameters[key], value]
      } else {
        parameters[key].push(value)
      }
    }
    printColorful('green', '[+] URL Parameters: ' + JSON.stringify(parameters))
  } else {
    printColorful('red', '[!] No URL or hash parameters found. If you do not intent to only guess parameters (see help), please provide an URL that already includes GET parameters.')
  }
  if (url.hash !== undefined && (url.hash.includes('?'))) {
    const fragmentParamsTemp = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1))
    if (fragmentParamsTemp.entries().next().value !== undefined) {
      for (const [key, value] of fragmentParamsTemp.entries()) {
        if (fragmentParameters[key] === undefined) {
          fragmentParameters[key] = value
        } else if (Array.isArray(fragmentParameters[key]) === false) {
          fragmentParameters[key] = [fragmentParameters[key], value]
        } else {
          fragmentParameters[key].push(value)
        }
      }
      printColorful('green', '[+] Fragment (#) Parameters: ' + JSON.stringify(parameters))
    }
  }
}

/**
 * @param {Object} page - The puppeteer page Object
 */
async function clearPageEventListeners (page) {
  await page.removeAllListeners('console')
  await page.removeAllListeners('response')
  await page.removeAllListeners('pageerror')
  await page.removeAllListeners('requestfailed')
}

/**
 * @param {Object} page - The puppeteer page Object
 */
async function initialPageLoad (page) {
  page.on('response', response => {
    // Detect immediate redirects
    if ([301, 302, 303, 307].includes(response.status())) {
      printColorful('red', `[!] Found redirect, could indicate erroneous initial URL or missing cookies: ${response.status()} ${response.url()}`)
    }
  })
  // Register listener for console messages
  page.on('console', message => {
    if (argv.verbose) printColorful('yellow', `[*] Console Message: ${message.text()}`)
    initialPageLoadConsoleMessages.push(message)
  }).on('pageerror', ({ message }) => {
    if (argv.verbose) printColorful('red', `[!] Page Error: ${message}`)
    initialPageLoadPageErrors.push(message)
  }).on('requestfailed', request => {
    if (argv.verbose) printColorful('red', `[!] Request Failed: ${request.url()}`)
    initialPageLoadRequestfailed.push(request)
  })

  if (argv.verbose) printColorful('green', '[+] Initial Page Load')
  // Excluded from Semgrep: https://github.com/lauritzh/domscan#security-considerations
  // nosemgrep javascript.puppeteer.security.audit.puppeteer-goto-injection.puppeteer-goto-injection
  await page.goto(url, { waitUntil: 'networkidle2' })
  printColorful('green', '[+] Wait until JS was evaluated...')
  await page.evaluate(async () => {
    window.waitedUntilJSExecuted = true
  })
  await page.waitForFunction('window.waitedUntilJSExecuted === true')
  if (argv.verbose) printColorful('green', '[+] Initial Page Load Complete')
}

/**
 * @param {Object} page - The puppeteer page Object
 */
async function guessParametersExtended (page) {
  // TODO: Implement parameter guessing (based on wordlist, use cache buster, determine additional parameters from JS code, etc.)
  // 1. Read parameter names from wordlist
  let parametersFromWordlist
  fs.readFile('parameter-names.txt', function (err, data) {
    if (err) throw err
    parametersFromWordlist = data.toString().split('\n')
  })

  // 2. Determine variable assignments in JS code
  const parametersFromJsCode = await page.evaluate(async () => {
    const inlineJsVariableAssignments = []
    const regex = /\b(var|let|const)\s+(\w+)\b/g
    const scripts = Array.from(document.scripts)

    for (const script of scripts) {
      const scriptContent = script.innerHTML
      if (scriptContent) {
        let match
        while ((match = regex.exec(scriptContent)) !== null) {
          inlineJsVariableAssignments.push(match[2])
        }
      } else if (script.src && new URL(script.src).hostname === window.location.hostname) { // Only fetch scripts from same origin
        try {
          const response = await fetch(script.src)
          const scriptContent = await response.text()
          let match
          while ((match = regex.exec(scriptContent)) !== null) {
            inlineJsVariableAssignments.push(match[2])
          }
        } catch (e) {
          console.log(e)
        }
      }
    }
    return inlineJsVariableAssignments
  })

  // Hook URLSearchParams: URLSearchParams.prototype.get = function() { alert(arguments[0]) }

  // TODO: Verify the guessed parameters by checking if they are reflected in the page or in console messages
  guessedParameters = [...new Set(parametersFromJsCode.concat(parametersFromWordlist))]
  printColorful('green', `[+] Guessed (but yet unverified) Parameters: ${JSON.stringify(guessedParameters)}`)
  /* // 3. Verify Guessed Params: Indicator for successful guess: Marker is reflected in page OR marker is reflected in console message
  for (const parameter of parameters) {
    if (guessedParameters.includes(parameter) === false) {
      printColorful('green', `[+] Guessing Parameter: ${parameter}`)
      await guessParameterBatch(page, parameter)
      guessedParameters.push(parameter)
    }
  } */
}

/**
 * @param {Object} page - The puppeteer page Object
 * @param {string} client - The puppeteer client Object
 */
async function registerAnalysisListeners (page, client) {
  // Register listener for console messages and redirects
  redirectedForParameter = false
  await client.on('Network.requestWillBeSent', (e) => {
    // Only print redirects that are not the initial page load
    if (redirectedForParameter || e.type !== 'Document' || e.documentURL === currentUrl.href || e.documentURL === currentUrl.origin + '/' || e.documentURL === url.href) {
      return
    }
    redirectedForParameter = true
    printColorful('green', `[+] Found redirect for Payload ${currentPayload} in Param ${currentParameter} to ${e.documentURL}`)
  })
  await page.on('response', response => {
    if (response.status() >= 400) {
      printColorful('red', `  [!] Found error: ${response.status()} ${response.url()}`)
    }
  }).on('console', message => {
    if (argv.verbose) printColorful('green', `[+] Console Message for Payload ${currentPayload}: ${message.text()}`)
    if (initialPageLoadConsoleMessages.includes(message) === false) {
      // Highlight findings that likely can be exploited
      if (argv.excludeFromConsole) {
        for (const excludeString of argv.excludeFromConsole) {
          if (message.text().includes(excludeString)) {
            return
          }
        }
      }
      if (message.text().includes('Content Security Policy') || message.text().includes('Uncaught SyntaxError')) {
        printColorful('turquoise', `[!] New Console Message for Payload ${currentPayload} in Param ${currentParameter}: ${message.text().trim()}`)
        addFinding('possible-xss', 'medium', `Console Message indicates CSP or Syntax Error: ${message.text().trim()}`)
      } else {
        printColorful('yellow', `  [*] New Console Message for Payload ${currentPayload} in Param ${currentParameter}: ${message.text().trim()}`)
        addFinding('new-console-message', 'low', message.text().trim())
      }
    }
  }).on('pageerror', ({ message }) => {
    if (argv.verbose) printColorful('red', `[!] Page Error for Payload ${currentPayload}: ${message}`)
    if (initialPageLoadPageErrors.includes(message) === false) {
      printColorful('red', `  [!] New Page Error for Payload ${currentPayload} in Param ${currentParameter}: ${message}`)
    }
  }).on('requestfailed', request => {
    if (argv.verbose) printColorful('red', `[!] Request Failed: ${request.url()}`)
    if (initialPageLoadRequestfailed.includes(request) === false) {
      if (argv.verbose) printColorful('yellow', `  [*] New Request Failed for Payload ${currentPayload} in Param ${currentParameter}: ${request.url()} - ${request.failure().errorText}`)
    }
  })
}

/**
 * @param {Object} page - The puppeteer page Object
 * @param {bool} fragment - Determine whether the query string or fragment should be scanned
 * @param {string} parameter - The parameter to be scanned
 */
async function scanParameterOrFragment (page, fragment = false, parameter = 'URL-FRAGMENT') {
  let markerFound = false
  currentParameter = parameter
  await page.on('response', response => {
    if ([301, 302, 303, 307].includes(response.status())) {
      printColorful('turquoise', `[!] Found redirect: ${response.status()} ${response.url()}`)
      addFinding('open-redirect', 'medium', `${response.status()} Redirect to ${response.url()}`)
    }
  })

  if (argv.verbose) printColorful('green', `[+] Starting Scan for Parameter: ${parameter}`)
  for (const payload of payloads) {
    // Craft URL
    currentPayload = payload
    if (argv.verbose) printColorful('green', `[+] Testing Payload: ${payload}`)
    const urlTemp = new URL(argv._[0]) // Create a new URL object to avoid side effects such as appending the payload multiple times
    if (fragment === true && parameter === 'URL-FRAGMENT') { // Directly inject payload to fragment
      urlTemp.hash = payload
    } else if (fragment === true) { // Set payload in URL fragment parameter
      const fragmentParamsTemp = new URLSearchParams(urlTemp.hash.slice(urlTemp.hash.indexOf('?') + 1))
      fragmentParamsTemp.set(parameter, payload)
      urlTemp.hash = url.hash.substring(0, urlTemp.hash.indexOf('?') + 1) + fragmentParamsTemp.toString()
    } else { // Set payload in query parameter
      urlTemp.searchParams.set(parameter, payload)
    }
    if (argv.verbose) printColorful('green', `[+] Resulting URL: ${urlTemp}`)
    currentUrl = urlTemp

    // Navigate to URL
    try {
      // Excluded from Semgrep: https://github.com/lauritzh/domscan#security-considerations
      // nosemgrep javascript.puppeteer.security.audit.puppeteer-goto-injection.puppeteer-goto-injection
      await page.goto(urlTemp, { waitUntil: 'networkidle2' })
      if (fragment) page.reload()
      await page.waitForFunction(() => document.readyState === 'complete')
      await page.evaluate(async () => {
        window.waitedUntilJSExecuted = true
      })
    } catch (e) {
      printColorful('red', `[!] Error during page load: ${e}`)
    }
    // Search for marker in document, only search once per parameter to reduce noise
    if (!markerFound) {
      try {
        markerFound = await page.evaluate((marker) => {
          return document.documentElement.innerHTML.includes(marker)
        }, marker)
        if (markerFound) {
          printColorful('turquoise', `[!] Marker was reflected on page for Payload ${payload} in Parameter ${parameter}`)
          addFinding('marker-reflected', 'info')
        }
      } catch (e) {
        printColorful('red', `[!] Error during page evaluation for Marker search: ${e}`)
      }
    }
    if (argv.verbose || argv.interactive) printColorful('green', `[+] Tested payload "${currentPayload}" in Parameter "${parameter}"`)
    if (argv.interactive) {
      await waitForAnyInput()
    }
  }
}

function waitForAnyInput () {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question('Press ENTER to continue...', () => {
      rl.close()
      resolve()
    })
  })
}

/**
 * @param {'white' | 'red' | 'green' | 'blue' | 'turquoise'} color - The color to print the text
 * @param {string} text - The text that should be printed
 */
function printColorful (color, text) {
  switch (color) {
    case 'white':
      color = '\x1b[37m'
      break
    case 'red':
      color = '\x1b[31m'
      break
    case 'green':
      color = '\x1b[32m'
      break
    case 'yellow':
      color = '\x1b[33m'
      break
    case 'blue':
      color = '\x1b[34m'
      break
    case 'turquoise':
      color = '\x1b[96m'
      break
    default:
      color = '\x1b[0m'
  }
  console.log(color + text + '\x1b[0m')
}

/**
 * @param {'possible-xss' | 'xss' | 'open-redirect' | 'marker-in-url' | 'marker-reflected' | 'new-console-message'} type - The vulnerability type
 * @param {'info' | 'low' | 'medium' | 'high'} severity - The severity of this finding
 * @param {string} comment
 */
function addFinding (type, severity, comment = '') {
  if (findings[currentParameter] === undefined) {
    findings[currentParameter] = []
  }
  findings[currentParameter].push([currentPayload, type, severity, comment])
}

function generateSummary () {
  printColorful('green', '#'.repeat(process.stdout.columns))
  printColorful('green', '[+] Summary:')
  const overallFindingsCount = Object.keys(findings).length
  if (overallFindingsCount === 0) {
    printColorful('green', '  [+] No findings! :(')
  } else {
    printColorful('green', `  [+] There were findings for ${overallFindingsCount} parameter(s) during this scan run.`)

    for (const parameter in findings) {
      printColorful('white', `[+] Parameter: ${parameter}`)

      const info = []
      const low = []
      const medium = []
      const high = []

      findings[parameter].forEach(finding => {
        switch (finding[2]) {
          case ('info'):
            if (info[finding[1]] === undefined) {
              info[finding[1]] = []
            }
            info[finding[1]].push(finding)
            break
          case ('low'):
            if (low[finding[1]] === undefined) {
              low[finding[1]] = []
            }
            low[finding[1]].push(finding)
            break
          case ('medium'):
            if (medium[finding[1]] === undefined) {
              medium[finding[1]] = []
            }
            medium[finding[1]].push(finding)
            break
          case ('high'):
            if (high[finding[1]] === undefined) {
              high[finding[1]] = []
            }
            high[finding[1]].push(finding)
            break
        }
      })
      printParameterSummary(high, 'HIGH')
      printParameterSummary(medium, 'MEDIUM')
      printParameterSummary(low, 'LOW')
      printParameterSummary(info, 'INFORMATIONAL')
    }
  }
}

/**
 * @param {array} severityFindings
 * @param {'info' | 'low' | 'medium' | 'high'} severity
 */
function printParameterSummary (severityFindings, severity) {
  const severityFindingsCount = Object.keys(severityFindings).length
  if (severityFindingsCount > 0) {
    printColorful('white', `  * ${severityFindingsCount} ${severity} finding(s)`)
    for (const severityFindingCategoryKey in severityFindings) {
      printColorful('white', `    [${severityFindingCategoryKey}]`)
      const uniquePayloads = new Set()
      severityFindings[severityFindingCategoryKey].forEach(item => {
        uniquePayloads.add(item[0])
      })
      uniquePayloads.forEach(payload => {
        printColorful('white', `    - Payload: ${payload}`)
      })
    }
  }
}

// Globally catch uncaught exceptions - this is necessary because the browser throws uncatchable exceptions from time to time
process.on('uncaughtException', (err) => {
  console.log(`${err.message}: ${err.stack}`)
})

/// /// /// /// /// a
// Main function
async function main () {
  // Display the parsed options and URL
  if (argv.verbose) {
    printColorful('green', `[+] Options: ${JSON.stringify(argv)}`)
  }
  printColorful('green', `[+] URL: ${url}`)

  // Parse URL parameters
  parseUrlParameters()

  // Add mutations of URL parameter values to the payload list
  printColorful('green', '[+] Adding mutations of given URL parameter values to payload list...')
  if (Object.keys(parameters).length !== 0) {
    for (const parameter in parameters) {
      for (const value of parameters[parameter]) {
        payloads.push(value + marker)
        payloads.push(marker + value + marker + '\'"><img src=x onerror=alert()>')
      }
    }
    payloads = [...new Set(payloads)] // Remove duplicates
  }
  if (argv.verbose) printColorful('green', `[+] Payloads: ${JSON.stringify(payloads)}`)

  // Start the browser
  printColorful('green', '[+] Starting browser...')
  const options = { headless: argv.headless ? 'new' : false }

  if (argv.proxy) {
    printColorful('green', `[+] Setting proxy to ${argv.proxy}...`)
    options.args = options.args || [] // Ensure args is initialized
    options.args.push(`--proxy-server=${argv.proxy}`)
    printColorful('green', '  [+] Disabling Certificate Validation...')
    options.args.push('--ignore-certificate-errors')
  }
  // Add No-Sandbox option
  if (argv.nosandbox) {
    options.args = options.args || [] // Ensure args is initialized
    options.args.push('--no-sandbox')
    printColorful('green', '  [+] Launching without sandbox...')
  }

  const browser = await pt.launch(options)
  const page = await browser.newPage()
  const client = await page.target().createCDPSession()
  await client.send('Network.enable')
  await client.send('Network.setCacheDisabled', { cacheDisabled: true })

  if (argv.manualLogin) {
    if (argv.headless) {
      console.error('Error: --manualLogin can only be used if --headless is set to "false".')
      process.exit(1)
    }
    printColorful('white', '[!] Manual Login: Perform any actions such as login, manually set cookies, ... and launch scan afterwards. Press ENTER to start scan.')
    // Excluded from Semgrep: https://github.com/lauritzh/domscan#security-considerations
    // nosemgrep javascript.puppeteer.security.audit.puppeteer-goto-injection.puppeteer-goto-injection
    await page.goto(url)
    await waitForAnyInput()
    await page.goto('about:blank')
  }

  if (argv.throttle) {
    printColorful('green', '[+] Throttling connection to 1 MBit/s...')
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: 125000,
      uploadThroughput: 125000
    })
  }

  // Set user agent
  if (argv.userAgent) {
    printColorful('green', '[+] Setting user agent...')
    if (argv.verbose) printColorful('green', `[+] User Agent: ${argv.userAgent}`)
    await page.setUserAgent(argv.userAgent)
  }

  // Hook the alert() and xyz() function within the page context
  await page.exposeFunction('alert', (message) => {
    printColorful('turquoise', `[!] Possible XSS: alert() triggered for Payload ${currentPayload}: ${message}`)
    addFinding('xss', 'high', `alert() triggered with message ${message}`)
  })
  await page.exposeFunction('xyz', (message) => {
    printColorful('turquoise', `[!] Possible XSS: xyz() triggered for Payload ${currentPayload}: ${message}`)
    addFinding('xss', 'high', `xyz() triggered with message ${message}`)
  })
  // Helper function to detect parameters
  await page.exposeFunction('domscan', (parameter, message) => {
    if (!guessedParameters.includes(parameter)) {
      guessedParameters.push(parameter)
      printColorful('yellow', `  [*] ${message}`)
    }
  })

  // Set cookies
  if (argv.cookies !== undefined) {
    printColorful('green', '[+] Setting cookies...')
    // If argv.cookies is string, convert to array
    if (typeof argv.cookies === 'string') {
      argv.cookies = [argv.cookies]
    }
    if (argv.verbose) printColorful('green', `[+] Cookies: ${JSON.stringify(argv.cookies)}`)
    const preparedCookies = argv.cookies.map(cookie => {
      return {
        name: cookie.split('=')[0],
        value: cookie.split('=')[1],
        domain: url.hostname,
        path: '/',
        httpOnly: false,
        secure: (url.protocol === 'https:'),
        sameSite: 'Lax'
      }
    })
    await page.setCookie(...preparedCookies)
  }

  // Set localStorage
  if (argv.localStorage !== undefined) {
    printColorful('green', '[+] Setting local storage...')
    if (argv.verbose) printColorful('turquoise', '[+] Local Storage: ' + JSON.stringify(argv.localStorage))
    if (typeof argv.localStorage === 'string') {
      argv.localStorage = [argv.localStorage]
    }
    argv.localStorage.forEach(item => {
      // Excluded from Semgrep: https://github.com/lauritzh/domscan#security-considerations
      // nosemgrep javascript.puppeteer.security.audit.puppeteer-evaluate-arg-injection.puppeteer-evaluate-arg-injection
      page.evaluateOnNewDocument((item) => {
        try {
          localStorage.setItem(item.split('=')[0], item.split('=')[1])
        } catch (e) {
          console.log(e)
        }
      }, item)
    })
  }

  if (argv.verbose) printColorful('green', '[+] Enable Request Interception')
  await page.setRequestInterception(true)

  // Request Interception - This listener can be registered once
  if (argv.verbose) printColorful('green', '[+] Register Request Interception')
  page.on('request', async request => {
    if (argv.verbose) printColorful('green', `[+] Intercepted Request: ${request.url()}`)
    // Intercept requests
    //   Search for marker in URL but ignore the initial page load where we set the marker ourselves
    if (request.url().includes(marker) && request.url() !== currentUrl.href) {
      printColorful('turquoise', `[!] Found marker ${marker} in URL: ${request.url()}`)
      addFinding('marker-in-url', 'info', `${marker} in URL: ${request.url()}`)
    }
    request.continue()
  })

  // Hook URLSearchParams to dynamically detect parameters
  /* global domscan */
  if (argv.guessParameters) {
    await page.evaluateOnNewDocument(async () => {
      URLSearchParams.prototype.has = new Proxy(URLSearchParams.prototype.has, {
        apply: function (target, thisArg, argumentsList) {
          domscan(argumentsList[0], `URLSearchParams.has() is called on ${argumentsList[0]}`)
          return target.apply(thisArg, argumentsList)
        }
      })
      URLSearchParams.prototype.get = new Proxy(URLSearchParams.prototype.get, {
        apply: function (target, thisArg, argumentsList) {
          domscan(argumentsList[0], `URLSearchParams.get() is called on ${argumentsList[0]}`)
          return target.apply(thisArg, argumentsList)
        }
      })
    })
  }

  // Initial page load to obtain our reference values
  await initialPageLoad(page)
  await new Promise(resolve => setTimeout(resolve, 10000))
  // Clear event listeners from initial page load
  await clearPageEventListeners(page)

  // Guess parameters
  if (argv.guessParameters) {
    // Search for input fields with names
    const parametersFromInputFields = await page.evaluate(async () => {
      console.log(document.getElementsByTagName('input'))
      const inputNames = []
      Array.from(document.getElementsByTagName('input')).forEach((item) => {
        console.log(item)
        inputNames.push(item.name)
      })
      return inputNames
    })
    if (parametersFromInputFields.length > 0) {
      printColorful('green', `[+] Guessed Parameters from Input Fields: ${JSON.stringify(parametersFromInputFields)}`)
      for (const parameter of parametersFromInputFields) {
        if (parameters[parameter] === undefined) {
          parameters[parameter] = marker
        }
      }
    }
  }
  if (argv.guessParametersExtended) {
    await guessParametersExtended(page)
  }
  if (guessedParameters) {
    // Add guessed parameters to parameter list
    for (const parameter of guessedParameters) {
      if (parameters[parameter] === undefined) {
        parameters[parameter] = marker
      }
    }
  }

  // Scan parameters
  if (Object.keys(parameters).length !== 0) {
    printColorful('green', '[+] Scanning parameters...')

    for (const parameter in parameters) {
      if (argv.excludedParameter && argv.excludedParameter.includes(parameter)) {
        printColorful('green', `[+] Skipping excluded parameter: ${parameter}`)
        continue
      }
      printColorful('green', `[+] Scanning parameter: ${parameter}`)
      await registerAnalysisListeners(page, client)
      try {
        await scanParameterOrFragment(page, false, parameter)
      } catch (e) {
        printColorful('red', `  [!] Error during scan of parameter ${parameter}: ${e}`)
      }
      await clearPageEventListeners(page)
    }
    // Determine whether there were parameters guessed sine the initial page load
    if (argv.guessParameters) {
      const newParameters = {}
      if (guessedParameters) {
        for (const tempParameter of guessedParameters) {
          if (parameters[tempParameter] === undefined) {
            newParameters[tempParameter] = marker
          }
        }
      }
      if (newParameters) {
        printColorful('green', `[+] Additional Parameters found since we started our scans. Starting a new scan for parameters: ${JSON.stringify(newParameters)}`)
        for (const parameter in newParameters) {
          if (argv.excludedParameter && argv.excludedParameter.includes(parameter)) {
            printColorful('green', `[+] Skipping excluded parameter: ${parameter}`)
            continue
          }
          printColorful('green', `[+] Scanning parameter: ${parameter}`)
          await registerAnalysisListeners(page, client)
          try {
            await scanParameterOrFragment(page, false, parameter)
          } catch (e) {
            printColorful('red', `[!] Error during scan of parameter ${parameter}: ${e}`)
          }
          await clearPageEventListeners(page)
        }
      }
    }
  } else {
    printColorful('red', '[+] No parameters to scan.')
  }

  // Scan URL Fragment parameters
  if (fragmentParameters) {
    printColorful('green', '[+] Scanning URL fragment parameters for injections...')
    for (const parameter in fragmentParameters) {
      if (argv.excludedParameter && argv.excludedParameter.includes(parameter)) {
        printColorful('green', `[+] Skipping excluded parameter: ${parameter}`)
        continue
      }
      printColorful('green', `[+] Scanning parameter: ${parameter}`)
      await registerAnalysisListeners(page, client)
      try {
        await scanParameterOrFragment(page, true, parameter)
      } catch (e) {
        printColorful('yellow', `  [+] Error during scan of parameter ${parameter}: ${e}`)
      }
      await clearPageEventListeners(page)
    }
  }

  // Scan URL fragments
  printColorful('green', '[+] Scanning URL fragment for injections...')
  await registerAnalysisListeners(page, client)
  await scanParameterOrFragment(page, true)
  await clearPageEventListeners(page)

  // Cleanup
  await browser.close()
  printColorful('green', '[+] Browser closed.')

  generateSummary()
}

main()
