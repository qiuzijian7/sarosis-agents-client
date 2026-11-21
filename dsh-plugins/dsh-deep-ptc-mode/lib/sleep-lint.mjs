// Static checks for waiting written into commands or run_code programs. Only a real pause counts: text in
// strings, comments and arguments is not one. A pause whose length cannot be read is allowed, because the
// runtime still bounds it: foreground commands move to the background and programs have a deadline.
// This is a heuristic reading of the source, not a parser: when in doubt it allows.
export const MAX_PAUSE_SECONDS = 5;

const UNIT_SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
const COMMAND_PREFIXES = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time', 'command', 'builtin', 'exec', 'nohup', 'nice', 'sudo', 'env']);
const HEREDOC = /^<<-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([^\s;&|<>()'"]+))/u;
// PowerShell cmdlets whose script block runs as a background job.
const JOB_STARTERS = new Set(['start-job', 'start-threadjob']);

function powerShellCommand(words) {
  const first = words[0] ?? '';
  const assignment = /^\$[\w:]+(=.*)?$/u.exec(first);
  if (!assignment) return first;
  const operator = assignment[1] ?? words[1];
  if (!operator?.startsWith('=')) return first;
  return operator.slice(1) || words[assignment[1] === undefined ? 2 : 1] || '';
}

// Split shell source into simple commands, each `{ words, background }`. Quoted text stays inside one word,
// comments and heredoc bodies disappear, and command substitutions become commands of their own.
function shellCommands(source, dialect) {
  const commands = [];
  const posix = dialect === 'posix';
  let words = [];
  let word;
  let heredocs = [];
  let i = 0;
  const append = text => { word = (word ?? '') + text; };
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = (background = false) => {
    endWord();
    if (words.length > 0) commands.push({ words, background });
    words = [];
  };
  const closing = (open, close) => {
    const opener = { ')': '(', '}': '{' }[close];
    const jobBlock = !posix && close === '}';
    let depth = 1;
    let quote;
    for (let at = open; at < source.length; at++) {
      const c = source[at];
      if (quote !== undefined) {
        if (c === (posix ? '\\' : '`') && quote === '"') at++;
        else if (c === quote) quote = undefined;
      } else if (c === (posix ? '\\' : '`')) at++;
      else if (jobBlock && c === '<' && source[at + 1] === '#') {
        const end = source.indexOf('#>', at + 2);
        if (end === -1) return source.length;
        at = end + 1;
      } else if (jobBlock && c === '#' && /[\s;({)}|&]/u.test(source[at - 1] ?? '')) {
        const end = source.indexOf('\n', at + 1);
        if (end === -1) return source.length;
        at = end;
      } else if (jobBlock && c === '@' && /^["']\r?\n/u.test(source.slice(at + 1, at + 4))) {
        const end = source.indexOf(`\n${source[at + 1]}@`, at + 2);
        if (end === -1) return source.length;
        at = end + 2;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === opener) depth++;
      else if (c === close && --depth === 0) return at;
    }
    return source.length;
  };
  const substitute = (start, end) => commands.push(...shellCommands(source.slice(start, end), dialect));
  const doubleQuoted = () => {
    for (i++; i < source.length && source[i] !== '"'; i++) {
      const c = source[i];
      if (c === (posix ? '\\' : '`') && i + 1 < source.length) append(source[++i]);
      else if (c === '$' && source[i + 1] === '(') {
        const end = closing(i + 2, ')');
        substitute(i + 2, end);
        i = end;
      } else if (c === '`' && posix) {
        const end = closing(i + 1, '`');
        substitute(i + 1, end);
        i = end;
      } else append(c);
    }
    i++;
  };
  while (i < source.length) {
    const c = source[i];
    const rest = source.slice(i, i + 2);
    if (c === '\n') {
      endCommand();
      i++;
      for (const terminator of heredocs) {
        while (i < source.length) {
          let end = source.indexOf('\n', i);
          if (end === -1) end = source.length;
          const line = source.slice(i, end);
          i = end + 1;
          if (line.replace(/^\t+/u, '').trimEnd() === terminator) break;
        }
      }
      heredocs = [];
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (word === undefined && c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (!posix && rest === '<#') {
      const end = source.indexOf('#>', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (!posix && (rest === "@'" || rest === '@"')) {
      const end = source.indexOf(`\n${rest[1]}@`, i + 2);
      append(source.slice(i + 2, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end + 3;
    } else if (posix && rest === '<<' && source[i + 2] !== '<') {
      const match = HEREDOC.exec(source.slice(i));
      if (match) heredocs.push(match[1] ?? match[2] ?? match[3]);
      i += match?.[0].length ?? 2;
    } else if (c === '\\' && posix) {
      append(source[i + 1] ?? '');
      i += 2;
    } else if (c === '`' && !posix) {
      append(source[i + 1] ?? '');
      i += 2;
    } else if (c === '`') {
      const end = closing(i + 1, '`');
      substitute(i + 1, end);
      i = end + 1;
    } else if (c === "'") {
      let end = source.indexOf("'", i + 1);
      while (!posix && end !== -1 && source[end + 1] === "'") end = source.indexOf("'", end + 2);
      append(source.slice(i + 1, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end + 1;
    } else if (c === '"') {
      append('');
      doubleQuoted();
    } else if (rest === '$(') {
      const end = closing(i + 2, ')');
      substitute(i + 2, end);
      append('');
      i = end + 1;
    } else if (c === '&' && (source[i + 1] === '>' || source[i - 1] === '>' || source[i - 1] === '<')) {
      append(c);
      i++;
    } else if (c === '&' && rest !== '&&' && source[i - 1] !== '&') {
      endCommand(true);
      i++;
    } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endCommand();
      i++;
    } else if (c === '{' && word === undefined && !posix && JOB_STARTERS.has(commandName(powerShellCommand(words)))) {
      // `Start-Job { Start-Sleep 60 }`: the block is the job's body, so nothing in it holds the foreground.
      const end = closing(i + 1, '}');
      if (end === source.length) {
        endCommand();
        i++;
      } else i = end + 1;
    } else if ((c === '{' || c === '}') && word === undefined) {
      endCommand();
      i++;
    } else {
      append(c);
      i++;
    }
  }
  endCommand();
  return commands;
}

// `sleep 2m 30s`, `sleep infinity`, `sleep -s 30`, `Start-Sleep -Milliseconds:500`.
function sleepSeconds(args) {
  let total = 0;
  for (let index = 0; index < args.length; index++) {
    const flag = /^-(\w+)(?::(.*))?$/u.exec(args[index]);
    if (flag) {
      const name = flag[1].toLowerCase();
      if (!/^(?:s|se|sec|seco|secon|second|seconds|m|mi|mil|mill|milli|millis|millise|milliseco|millisecon|millisecond|milliseconds)$/u.test(name)) return total;
      const value = Number(flag[2] ?? args[++index]);
      if (!Number.isNaN(value)) total += name.startsWith('m') ? value / 1000 : value;
      continue;
    }
    if (args[index] === 'infinity') return Infinity;
    const match = /^([0-9]*\.?[0-9]+)([smhd]?)$/u.exec(args[index]);
    if (match) total += Number(match[1]) * UNIT_SECONDS[match[2]];
  }
  return total;
}

function commandName(word) {
  return word.replace(/^.*[\\/]/u, '').replace(/\.exe$/iu, '').toLowerCase();
}

// The longest pause one simple command starts in the foreground, looking through shells and wrappers.
function commandPause(words, dialect) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_]\w*=/u.test(word) || COMMAND_PREFIXES.has(word) || (index > 0 && word.startsWith('-') && COMMAND_PREFIXES.has(words[index - 1]))) index++;
    else break;
  }
  const name = commandName(words[index] ?? '');
  const args = words.slice(index + 1);
  if (name === 'sleep' || name === 'start-sleep') return sleepSeconds(args);
  if (name === 'timeout' && args[0]?.toLowerCase() === '/t') {
    const seconds = Number(args[1]);
    return Number.isNaN(seconds) ? 0 : seconds < 0 ? Infinity : seconds;
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
    const script = args.findIndex(arg => /^-[a-z]*c$/u.test(arg));
    return script === -1 ? 0 : shellPauseSeconds(args[script + 1] ?? '', 'posix');
  }
  if (name === 'pwsh' || name === 'powershell') {
    const script = args.findIndex(arg => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/iu.test(arg));
    return script === -1 ? 0 : shellPauseSeconds(args.slice(script + 1).join(' '), 'powershell');
  }
  if (name === 'cmd') {
    const script = args.findIndex(arg => /^\/[ck]$/iu.test(arg));
    return script === -1 ? 0 : shellPauseSeconds(args.slice(script + 1).join(' '), 'powershell');
  }
  if (name === 'wsl') {
    let at = 0;
    while (at < args.length && args[at].startsWith('-')) {
      const flag = args[at].toLowerCase();
      if (flag === '--' || flag === '-e' || flag === '--exec') {
        at++;
        break;
      }
      at += ['-d', '--distribution', '-u', '--user', '--cd'].includes(flag) ? 2 : 1;
    }
    return commandPause(args.slice(at), 'posix');
  }
  return 0;
}

/**
 * Longest foreground pause a command starts, in seconds; 0 when there is none.
 * @param command - shell source.
 * @param dialect - `posix` for bash and zsh, `powershell` for PowerShell, whose quoting differs.
 */
export function shellPauseSeconds(command, dialect = 'posix') {
  let longest = 0;
  for (const { words, background } of shellCommands(command, dialect)) {
    if (!background) longest = Math.max(longest, commandPause(words, dialect));
  }
  return longest;
}

const REGEX_FOLLOWS = /(?:^|[=(,;:!&|?{}[+\-*%<>~^\n]|\b(?:return|typeof|case|in|of|delete|void|throw|new|else|yield|await))\s*$/u;

// Blank comments and the text of strings, templates and regular expressions, keeping every offset.
function maskTypeScript(code) {
  const out = code.split('');
  const blank = (from, to) => {
    for (let at = from; at < to && at < out.length; at++) if (out[at] !== '\n') out[at] = ' ';
  };
  const templates = [];
  let depth = 0;
  let i = 0;
  const template = () => {
    const start = i;
    while (i < code.length) {
      if (code[i] === '\\') i += 2;
      else if (code[i] === '`') {
        blank(start, i);
        i++;
        return;
      } else if (code[i] === '$' && code[i + 1] === '{') {
        blank(start, i + 2);
        i += 2;
        templates.push(depth);
        depth = 0;
        return;
      } else i++;
    }
    blank(start, i);
  };
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      while (i < code.length && code[i] !== '\n') i++;
      blank(start, i);
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const start = ++i;
      while (i < code.length && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1;
      blank(start, i);
      i++;
    } else if (c === '`') {
      i++;
      template();
    } else if (c === '/' && REGEX_FOLLOWS.test(out.slice(Math.max(0, i - 12), i).join(''))) {
      const start = ++i;
      let inClass = false;
      while (i < code.length && code[i] !== '\n' && (inClass || code[i] !== '/')) {
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        i += code[i] === '\\' ? 2 : 1;
      }
      blank(start, i);
      i++;
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      if (depth === 0 && templates.length > 0) {
        depth = templates.pop();
        i++;
        template();
      } else {
        depth--;
        i++;
      }
    } else i++;
  }
  return out.join('');
}

// Blank Python comments and string text, keeping every offset.
function maskPython(code) {
  const out = code.split('');
  const blank = (from, to) => {
    for (let at = from; at < to && at < out.length; at++) if (out[at] !== '\n') out[at] = ' ';
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '#') {
      const start = i;
      while (i < code.length && code[i] !== '\n') i++;
      blank(start, i);
    } else if (c === '"' || c === "'") {
      const triple = code.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      const start = i + quote.length;
      i = start;
      while (i < code.length && !code.startsWith(quote, i) && (triple || code[i] !== '\n')) i += code[i] === '\\' ? 2 : 1;
      blank(start, i);
      i += quote.length;
    } else i++;
  }
  return out.join('');
}

// The argument list of the call whose opening parenthesis is at `open`, in masked source.
function callArguments(source, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) {
        args.push(source.slice(start, i).trim());
        return { args: args.filter(arg => arg !== ''), end: i };
      }
    } else if (c === ',' && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// The value of a number, a named constant or a product of those; undefined when it cannot be read.
function constantValue(text, declaration, depth = 0) {
  if (depth > 3 || typeof text !== 'string' || text === '') return undefined;
  let value = 1;
  for (const factor of text.split('*').map(part => part.trim())) {
    let number;
    if (/^[0-9][0-9_]*(?:\.[0-9_]+)?(?:e[0-9]+)?$/iu.test(factor)) number = Number(factor.replaceAll('_', ''));
    else if (/^[A-Za-z_$][\w$]*$/u.test(factor)) number = constantValue(declaration(factor), declaration, depth + 1);
    if (number === undefined) return undefined;
    value *= number;
  }
  return value;
}

const WATCHDOG_CALLBACK = /\b(?:reject|rej|abort|kill|cancel|fail)\b|\bthrow\b/u;

function typeScriptPauseIssue(masked) {
  const limitMs = MAX_PAUSE_SECONDS * 1000;
  const declaration = name => new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*(?::[^=\\n]+)?=\\s*([^;,\\n]+)`, 'u').exec(masked)?.[1];
  const value = text => constantValue(text, declaration);
  const promises = [];
  for (const match of masked.matchAll(/\bnew\s+Promise\b(?:<[^(\n]*>)?\s*\(/gu)) {
    const call = callArguments(masked, match.index + match[0].length - 1);
    if (call) promises.push([match.index, call.end]);
  }
  const inPromise = at => promises.some(([from, to]) => at > from && at < to);
  // A helper that hands a parameter to a timer: every literal at its call sites is that timer's delay.
  const helperDelay = (parameter, at) => {
    const helpers = [...masked.matchAll(/\b(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)[^\n]*?=>|function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(\n]*>)?\(\s*([A-Za-z_$][\w$]*))/gu)];
    const helper = helpers.filter(found => found.index < at && (found[2] ?? found[4]) === parameter).at(-1);
    const name = helper?.[1] ?? helper?.[3];
    if (name === undefined) return undefined;
    let longest;
    for (const call of masked.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`, 'gu'))) {
      if (call.index === helper.index + helper[0].indexOf(name)) continue;
      const delay = value(callArguments(masked, call.index + call[0].length - 1)?.args[0]);
      if (delay !== undefined) longest = Math.max(longest ?? 0, delay);
    }
    return longest;
  };
  const aliases = [...masked.matchAll(/\bsetTimeout\s*:\s*([A-Za-z_$][\w$]*)/gu)].map(found => found[1]);
  const timers = ['setTimeout', 'setInterval', ...aliases].map(escapeRegExp).join('|');
  for (const match of masked.matchAll(new RegExp(`(?<![\\w$])(${timers})\\s*\\(`, 'gu'))) {
    const call = callArguments(masked, match.index + match[0].length - 1);
    if (call === undefined) continue;
    const [first, second] = call.args;
    // setTimeout(callback, ms) from the global timers, setTimeout(ms, value) from timers/promises.
    const leading = value(first);
    const promised = leading !== undefined || (call.args.length === 1 && /^[A-Za-z_$][\w$]*$/u.test(first ?? '') && aliases.includes(match[1]));
    if (!promised && !(inPromise(match.index) && !WATCHDOG_CALLBACK.test(first ?? ''))) continue;
    const expression = promised ? first : second;
    const delay = value(expression) ?? (/^[A-Za-z_$][\w$]*$/u.test(expression ?? '') ? helperDelay(expression, match.index) : undefined);
    if (delay !== undefined && delay > limitMs) return `a ${delay} ms ${match[1] === 'setInterval' ? 'setInterval' : 'setTimeout'}`;
  }
  for (const match of masked.matchAll(/\bAtomics\.wait\s*\(/gu)) {
    const args = callArguments(masked, match.index + match[0].length - 1)?.args;
    if (args === undefined) continue;
    if (args.length < 4) return 'Atomics.wait without a timeout';
    const delay = value(args[3]);
    if (delay !== undefined && delay > limitMs) return `a ${delay} ms Atomics.wait`;
  }
  return undefined;
}

function pythonPauseIssue(masked) {
  const declaration = name => new RegExp(`^[ \\t]*${escapeRegExp(name)}\\s*=\\s*([^\\n#]+)`, 'mu').exec(masked)?.[1]?.trim();
  const imported = /^[ \t]*from[ \t]+(?:time|asyncio)[ \t]+import\b[^\n]*\bsleep\b/mu.test(masked);
  for (const match of masked.matchAll(/(?<![\w.])(?:(?:time|asyncio)\.)?sleep\s*\(/gu)) {
    if (!match[0].includes('.') && !imported) continue;
    const seconds = constantValue(callArguments(masked, match.index + match[0].length - 1)?.args[0], declaration);
    if (seconds !== undefined && seconds > MAX_PAUSE_SECONDS) return `a ${seconds} s sleep`;
  }
  return undefined;
}

/**
 * A reason when a run_code program really waits longer than allowed.
 * @param code - program source.
 * @param language - the active PTC runtime's language.
 */
export function programPauseIssue(code, language = 'typescript') {
  return language === 'python' ? pythonPauseIssue(maskPython(code)) : typeScriptPauseIssue(maskTypeScript(code));
}
