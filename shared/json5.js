// Parser JSON5 propio (sin dependencias), pensado para archivos .hbs:
// comentarios, claves sin comillas, comas finales, comillas simples, hex,
// Infinity/NaN (los rechaza luego la validación). Seguro ante archivos hostiles:
// limita tamaño y profundidad, y rechaza claves peligrosas (__proto__).

export class JSON5Error extends Error {
  constructor(message, line, column) {
    super(`${message} (línea ${line}, columna ${column})`);
    this.name = 'JSON5Error';
    this.reason = message;
    this.line = line;
    this.column = column;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_START = /[\p{L}\p{Nl}$_]/u;
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_‌‍]/u;
const WS = new Set([' ', '\t', '\n', '\r', '\v', '\f', ' ', ' ', ' ', '﻿']);

export function parseJSON5(text, { maxDepth = 64, maxLength = 4 * 1024 * 1024 } = {}) {
  if (typeof text !== 'string') throw new JSON5Error('El contenido no es texto', 1, 1);
  if (text.length > maxLength) throw new JSON5Error(`El archivo es demasiado grande (máx. ${Math.round(maxLength / 1024)} KB)`, 1, 1);
  let i = 0;
  let line = 1;
  let col = 1;

  const fail = (msg) => {
    throw new JSON5Error(msg, line, col);
  };
  const peek = () => text[i];
  const next = () => {
    const ch = text[i++];
    if (ch === '\n' || (ch === '\r' && text[i] !== '\n') || ch === ' ' || ch === ' ') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    return ch;
  };
  const describe = (ch) => (ch === undefined ? 'el final del archivo' : `'${ch === '\n' ? '\\n' : ch}'`);

  function skip() {
    for (;;) {
      const ch = peek();
      if (ch === undefined) return;
      if (WS.has(ch) || (ch >= ' ' && ch <= ' ') || ch === ' ' || ch === ' ' || ch === '　') {
        next();
      } else if (ch === '/' && text[i + 1] === '/') {
        while (peek() !== undefined && peek() !== '\n' && peek() !== '\r') next();
      } else if (ch === '/' && text[i + 1] === '*') {
        next();
        next();
        while (!(peek() === '*' && text[i + 1] === '/')) {
          if (peek() === undefined) fail('Comentario /* sin cerrar');
          next();
        }
        next();
        next();
      } else {
        return;
      }
    }
  }

  function parseString() {
    const quote = next();
    let out = '';
    for (;;) {
      const ch = next();
      if (ch === undefined) fail('Texto entre comillas sin cerrar');
      if (ch === quote) return out;
      if (ch === '\n' || ch === '\r') fail('Salto de línea dentro de un texto');
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const e = next();
      switch (e) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0':
          if (/[0-9]/.test(peek() || '')) fail('Escape \\0 seguido de un número');
          out += '\0';
          break;
        case 'x': {
          const h = text.substr(i, 2);
          if (!/^[0-9a-fA-F]{2}$/.test(h)) fail('Escape \\x inválido');
          next(); next();
          out += String.fromCharCode(parseInt(h, 16));
          break;
        }
        case 'u': {
          const h = text.substr(i, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Escape \\u inválido');
          for (let k = 0; k < 4; k += 1) next();
          out += String.fromCharCode(parseInt(h, 16));
          break;
        }
        case '\r':
          if (peek() === '\n') next();
          break;
        case '\n':
        case ' ':
        case ' ':
          break;
        case undefined:
          fail('Texto entre comillas sin cerrar');
          break;
        default:
          if (/[1-9]/.test(e)) fail(`Escape \\${e} inválido`);
          out += e;
      }
    }
  }

  function parseIdentifier() {
    let out = '';
    const ch = peek();
    if (ch === undefined || !(ID_START.test(ch) || ch === '\\')) fail(`Se esperaba un nombre de propiedad y llegó ${describe(ch)}`);
    while (peek() !== undefined && (ID_PART.test(peek()) || peek() === '\\')) {
      if (peek() === '\\') {
        next();
        if (next() !== 'u') fail('Escape inválido en nombre de propiedad');
        const h = text.substr(i, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Escape \\u inválido');
        for (let k = 0; k < 4; k += 1) next();
        out += String.fromCharCode(parseInt(h, 16));
      } else {
        out += next();
      }
    }
    return out;
  }

  function parseNumber() {
    const start = i;
    let sign = 1;
    if (peek() === '+' || peek() === '-') {
      if (next() === '-') sign = -1;
    }
    if (text.startsWith('Infinity', i)) {
      for (let k = 0; k < 8; k += 1) next();
      return sign * Infinity;
    }
    if (text.startsWith('NaN', i)) {
      for (let k = 0; k < 3; k += 1) next();
      return NaN;
    }
    if (peek() === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
      next(); next();
      let hex = '';
      while (/[0-9a-fA-F]/.test(peek() || '')) hex += next();
      if (!hex) fail('Número hexadecimal inválido');
      return sign * parseInt(hex, 16);
    }
    let digits = '';
    while (/[0-9]/.test(peek() || '')) digits += next();
    let frac = '';
    if (peek() === '.') {
      next();
      while (/[0-9]/.test(peek() || '')) frac += next();
    }
    if (!digits && !frac) {
      i = start;
      fail(`Valor inesperado ${describe(peek())}`);
    }
    let exp = '';
    if (peek() === 'e' || peek() === 'E') {
      next();
      if (peek() === '+' || peek() === '-') exp += next();
      let ed = '';
      while (/[0-9]/.test(peek() || '')) ed += next();
      if (!ed) fail('Exponente inválido');
      exp += ed;
    }
    return sign * Number(`${digits || '0'}.${frac || '0'}${exp ? `e${exp}` : ''}`);
  }

  function parseValue(depth) {
    if (depth > maxDepth) fail(`Anidamiento demasiado profundo (máx. ${maxDepth})`);
    skip();
    const ch = peek();
    if (ch === '{') return parseObject(depth + 1);
    if (ch === '[') return parseArray(depth + 1);
    if (ch === '"' || ch === "'") return parseString();
    if (ch === 't' && text.startsWith('true', i)) { for (let k = 0; k < 4; k += 1) next(); return true; }
    if (ch === 'f' && text.startsWith('false', i)) { for (let k = 0; k < 5; k += 1) next(); return false; }
    if (ch === 'n' && text.startsWith('null', i)) { for (let k = 0; k < 4; k += 1) next(); return null; }
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9') || ch === 'I' || ch === 'N') return parseNumber();
    return fail(`Valor inesperado ${describe(ch)}`);
  }

  function parseObject(depth) {
    next(); // {
    const obj = {};
    skip();
    if (peek() === '}') {
      next();
      return obj;
    }
    for (;;) {
      skip();
      const keyLine = line;
      const keyCol = col;
      const key = peek() === '"' || peek() === "'" ? parseString() : parseIdentifier();
      if (FORBIDDEN_KEYS.has(key)) throw new JSON5Error(`Clave no permitida "${key}"`, keyLine, keyCol);
      skip();
      if (next() !== ':') fail(`Falta ':' después de "${key}"`);
      const value = parseValue(depth);
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
      skip();
      const sep = next();
      if (sep === '}') return obj;
      if (sep !== ',') fail(`Se esperaba ',' o '}' y llegó ${describe(sep)}`);
      skip();
      if (peek() === '}') {
        next();
        return obj;
      }
    }
  }

  function parseArray(depth) {
    next(); // [
    const arr = [];
    skip();
    if (peek() === ']') {
      next();
      return arr;
    }
    for (;;) {
      arr.push(parseValue(depth));
      skip();
      const sep = next();
      if (sep === ']') return arr;
      if (sep !== ',') fail(`Se esperaba ',' o ']' y llegó ${describe(sep)}`);
      skip();
      if (peek() === ']') {
        next();
        return arr;
      }
    }
  }

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const value = parseValue(0);
  skip();
  if (i < text.length) fail(`Sobra contenido: ${describe(peek())}`);
  return value;
}
