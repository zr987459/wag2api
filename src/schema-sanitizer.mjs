/**
 * JSON Schema Sanitizer for Google Cloud Code / Gemini
 *
 * 核心机制：
 * Google Gemini API 严格限制 JSON Schema 语法，任何不支持的关键字都会导致 400 校验错误：
 * 1. 字段白名单过滤（仅允许 type, description, properties, required, items, enum）；
 * 2. 将 const 语法重写为 enum: [val]；
 * 3. 将类型转换为 Google 协议大写形式（STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT）；
 * 4. 自动为无 properties 的空 object 补齐占位属性，避免接口拒绝。
 */

function toGoogleType(type) {
  if (!type || typeof type !== 'string') return 'OBJECT';
  const typeMap = {
    'string': 'STRING',
    'number': 'NUMBER',
    'integer': 'INTEGER',
    'boolean': 'BOOLEAN',
    'array': 'ARRAY',
    'object': 'OBJECT',
    'null': 'STRING',
  };
  return typeMap[type.toLowerCase()] || type.toUpperCase();
}

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 解析 #/$defs/X、#/definitions/X 这类本地 $ref；解析不到返回 undefined */
function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObj(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return isPlainObj(cur) ? cur : undefined;
}

/**
 * 预展开 Gemini 不支持的组合语法（只在出现这些关键字时改写，其它 schema 输出与之前逐字节一致）：
 *  - $ref → 内联 $defs / definitions 中的定义（循环引用降级为 object，解析不到降级为 string）
 *  - allOf → 合并各分支的 properties / required / type
 *  - anyOf / oneOf（且无 type）→ 取第一个非 null 分支（如 Optional[str] 的 [{type:string},{type:null}] → string）
 *  - type: ["string","null"] → 第一个非 null 类型
 * 此前这些写法会被白名单直接丢掉，字段退化成带 _empty 占位的 OBJECT，模型会传错类型。
 */
function flattenCombinators(schema, root, refStack) {
  let node = schema;
  if (typeof node.$ref === 'string') {
    const { $ref, ...rest } = node;
    if (refStack.includes($ref)) {
      node = { type: 'object', ...(rest.description ? { description: rest.description } : {}) };
    } else {
      const target = resolveRef($ref, root);
      if (!target) {
        node = { type: 'string', description: rest.description || `(Unresolved $ref: ${$ref})` };
      } else {
        refStack = [...refStack, $ref];
        node = flattenCombinators({ ...target, ...rest }, root, refStack).node;
      }
    }
  }
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node;
    const merged = { ...rest };
    for (const branch of allOf) {
      if (!isPlainObj(branch)) continue;
      const b = flattenCombinators(branch, root, refStack).node;
      if (isPlainObj(b.properties)) merged.properties = { ...(merged.properties || {}), ...b.properties };
      if (Array.isArray(b.required)) merged.required = [...new Set([...(merged.required || []), ...b.required])];
      for (const [k, v] of Object.entries(b)) {
        if (k !== 'properties' && k !== 'required' && merged[k] === undefined) merged[k] = v;
      }
    }
    node = merged;
  }
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
  if (union) {
    const { anyOf, oneOf, ...rest } = node;
    node = rest;
    if (rest.type === undefined) {
      const branches = union.filter(isPlainObj).map(b => flattenCombinators(b, root, refStack).node);
      const pick = branches.find(b => b.type !== 'null' && !(Array.isArray(b.type) && b.type.every(t => t === 'null')));
      if (pick) {
        node = { ...pick, ...rest };
      }
    }
  }
  if (Array.isArray(node.type)) {
    node = { ...node, type: node.type.find(t => typeof t === 'string' && t !== 'null') || 'string' };
  }
  return { node, refStack };
}

export function sanitizeSchema(schema, _root = schema, _refStack = []) {
  if (!schema || typeof schema !== 'object') {
    return {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'Execution parameter' }
      },
      required: ['reason']
    };
  }

  const ALLOWED_FIELDS = new Set([
    'type',
    'description',
    'properties',
    'required',
    'items',
    'enum',
    'title'
  ]);

  if ('$ref' in schema || 'allOf' in schema || 'anyOf' in schema || 'oneOf' in schema || Array.isArray(schema.type)) {
    ({ node: schema, refStack: _refStack } = flattenCombinators(schema, _root, _refStack));
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(schema)) {
    // 转换 const 为 enum
    if (key === 'const') {
      sanitized.enum = [value];
      continue;
    }

    if (!ALLOWED_FIELDS.has(key)) {
      continue;
    }

    if (key === 'type') {
      sanitized.type = toGoogleType(value);
    } else if (key === 'properties' && value && typeof value === 'object') {
      sanitized.properties = {};
      const sortedPropKeys = Object.keys(value).sort();
      for (const propKey of sortedPropKeys) {
        sanitized.properties[propKey] = sanitizeSchema(value[propKey], _root, _refStack);
      }
    } else if (key === 'items' && value && typeof value === 'object') {
      if (Array.isArray(value)) {
        sanitized.items = value.map(item => sanitizeSchema(item, _root, _refStack));
      } else {
        sanitized.items = sanitizeSchema(value, _root, _refStack);
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeSchema(value, _root, _refStack);
    } else {
      sanitized[key] = value;
    }
  }

  // 过滤 required 数组，确保仅包含 properties 中真实存在的字段名（避免 Google 报 required[X]: property is not defined）
  if (Array.isArray(sanitized.required)) {
    if (sanitized.properties && typeof sanitized.properties === 'object') {
      const validPropNames = new Set(Object.keys(sanitized.properties));
      sanitized.required = sanitized.required.filter(r => typeof r === 'string' && validPropNames.has(r));
      if (sanitized.required.length === 0) {
        delete sanitized.required;
      }
    } else {
      delete sanitized.required;
    }
  }

  // ARRAY 类型必须具备 items 字段
  if (sanitized.type === 'ARRAY' && !sanitized.items) {
    sanitized.items = { type: 'STRING' };
  }

  // 默认补齐 type
  if (!sanitized.type) {
    sanitized.type = 'OBJECT';
  }

  // 若为 OBJECT 但无 properties，Google 可能会拒收，补充占位属性
  if (sanitized.type === 'OBJECT' && (!sanitized.properties || Object.keys(sanitized.properties).length === 0)) {
    sanitized.properties = {
      _empty: {
        type: 'BOOLEAN',
        description: 'Parameter presence flag'
      }
    };
  }

  return sanitized;
}
