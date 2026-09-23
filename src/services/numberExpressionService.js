const MAX_INPUT_LENGTH = 80;
const MAX_TOKEN_COUNT = 40;
const MAX_PARENTHESES_DEPTH = 8;
const MAX_INTEGER_DIGITS = 18;
const MAX_INTERMEDIATE_COMPONENT = (10n ** 36n) - 1n;

class NumberExpressionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NumberExpressionError';
    this.code = code;
  }
}

function abs(value) {
  return value < 0n ? -value : value;
}

function gcd(left, right) {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function ensureBounded(numerator, denominator) {
  if (abs(numerator) > MAX_INTERMEDIATE_COMPONENT || abs(denominator) > MAX_INTERMEDIATE_COMPONENT) {
    throw new NumberExpressionError('INTERMEDIATE_LIMIT', '算式中間結果太大，請使用較簡短的整數運算。');
  }
}

function rational(numerator, denominator = 1n) {
  if (denominator === 0n) {
    throw new NumberExpressionError('DIVISION_BY_ZERO', '除數不能是 0。');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = gcd(numerator, denominator);
  const normalized = { numerator: numerator / divisor, denominator: denominator / divisor };
  ensureBounded(normalized.numerator, normalized.denominator);
  return normalized;
}

function add(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function subtract(left, right) {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function multiply(left, right) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left, right) {
  if (right.numerator === 0n) {
    throw new NumberExpressionError('DIVISION_BY_ZERO', '除數不能是 0。');
  }
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function tokenize(input) {
  const source = String(input ?? '').trim();
  if (!source || source.length > MAX_INPUT_LENGTH) {
    throw new NumberExpressionError('INPUT_LENGTH', `算式長度需介於 1 到 ${MAX_INPUT_LENGTH} 個字元。`);
  }

  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (/\d/u.test(character)) {
      const start = index;
      while (index < source.length && /\d/u.test(source[index])) index += 1;
      const digits = source.slice(start, index);
      if (digits.length > MAX_INTEGER_DIGITS) {
        throw new NumberExpressionError('INTEGER_LIMIT', `單一整數最多 ${MAX_INTEGER_DIGITS} 位數。`);
      }
      tokens.push({ type: 'integer', value: BigInt(digits) });
    } else if ('+-*/()'.includes(character)) {
      tokens.push({ type: character, value: character });
      index += 1;
    } else if (character === '.' || character === 'e' || character === 'E') {
      throw new NumberExpressionError('DECIMAL_OR_EXPONENT', '只接受十進位整數，不能使用小數或科學記號。');
    } else {
      throw new NumberExpressionError('INVALID_TOKEN', '算式只接受整數、+、-、*、/ 和括號。');
    }
    if (tokens.length > MAX_TOKEN_COUNT) {
      throw new NumberExpressionError('TOKEN_LIMIT', `算式最多可使用 ${MAX_TOKEN_COUNT} 個符號。`);
    }
  }
  return tokens;
}

function parseNumberExpression(input) {
  const tokens = tokenize(input);
  let cursor = 0;
  let depth = 0;

  const peek = () => tokens[cursor] || null;
  const consume = (type) => {
    const token = peek();
    if (!token || token.type !== type) {
      throw new NumberExpressionError('INVALID_SYNTAX', '算式格式不正確，請檢查運算子與括號。');
    }
    cursor += 1;
    return token;
  };

  const parseFactor = () => {
    const token = peek();
    if (token?.type === '+' || token?.type === '-') {
      cursor += 1;
      const value = parseFactor();
      return token.type === '-' ? rational(-value.numerator, value.denominator) : value;
    }
    if (token?.type === 'integer') {
      cursor += 1;
      return rational(token.value);
    }
    if (token?.type === '(') {
      depth += 1;
      if (depth > MAX_PARENTHESES_DEPTH) {
        throw new NumberExpressionError('PARENTHESIS_DEPTH', `括號最多巢狀 ${MAX_PARENTHESES_DEPTH} 層。`);
      }
      cursor += 1;
      const value = parseExpression();
      consume(')');
      depth -= 1;
      return value;
    }
    throw new NumberExpressionError('INVALID_SYNTAX', '算式格式不正確，請檢查運算子與括號。');
  };

  const parseTerm = () => {
    let value = parseFactor();
    while (peek()?.type === '*' || peek()?.type === '/') {
      const operator = tokens[cursor++].type;
      const right = parseFactor();
      value = operator === '*' ? multiply(value, right) : divide(value, right);
    }
    return value;
  };

  const parseExpression = () => {
    let value = parseTerm();
    while (peek()?.type === '+' || peek()?.type === '-') {
      const operator = tokens[cursor++].type;
      const right = parseTerm();
      value = operator === '+' ? add(value, right) : subtract(value, right);
    }
    return value;
  };

  const value = parseExpression();
  if (cursor !== tokens.length) {
    throw new NumberExpressionError('IMPLICIT_MULTIPLICATION', '不支援隱式乘法，請明確使用 *。');
  }
  if (value.denominator !== 1n) {
    throw new NumberExpressionError('NON_INTEGER_RESULT', '算式結果必須是整數。');
  }
  return value.numerator;
}

function evaluateNumberExpression(input) {
  try {
    const value = parseNumberExpression(input);
    return { ok: true, value, result: value.toString() };
  } catch (error) {
    if (error instanceof NumberExpressionError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

module.exports = {
  MAX_INPUT_LENGTH,
  MAX_INTEGER_DIGITS,
  MAX_INTERMEDIATE_COMPONENT,
  MAX_PARENTHESES_DEPTH,
  MAX_TOKEN_COUNT,
  NumberExpressionError,
  evaluateNumberExpression,
  parseNumberExpression,
  tokenize,
};
