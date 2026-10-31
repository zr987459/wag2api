package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON Schema Sanitizer for Google Cloud Code / Gemini（移植自 src/schema-sanitizer.mjs）
 *
 * 1. 字段白名单过滤（仅允许 type, description, properties, required, items, enum, title）；
 * 2. 将 const 语法重写为 enum: [val]；
 * 3. 将类型转换为 Google 协议大写形式（STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT）；
 * 4. 自动为无 properties 的空 object 补齐占位属性，避免接口拒绝。
 */
object SchemaSanitizer {

    private val TYPE_MAP = mapOf(
        "string" to "STRING",
        "number" to "NUMBER",
        "integer" to "INTEGER",
        "boolean" to "BOOLEAN",
        "array" to "ARRAY",
        "object" to "OBJECT",
        "null" to "STRING"
    )

    private val ALLOWED_FIELDS = setOf("type", "description", "properties", "required", "items", "enum", "title")

    private fun toGoogleType(type: Any?): String {
        if (type !is String || type.isEmpty()) return "OBJECT"
        return TYPE_MAP[type.lowercase()] ?: type.uppercase()
    }

    private fun isPlainObj(v: Any?): Boolean = v is JSONObject

    /** Object.entries：对象按键，数组按下标 */
    private fun entries(v: Any?): List<Pair<String, Any?>> = when (v) {
        is JSONObject -> {
            val l = ArrayList<Pair<String, Any?>>()
            val it = v.keys()
            while (it.hasNext()) {
                val k = it.next() as String
                l.add(k to v.opt(k))
            }
            l
        }
        is JSONArray -> (0 until v.length()).map { it.toString() to v.opt(it) }
        is String -> v.indices.map { it.toString() to v[it].toString() }
        else -> emptyList()
    }

    private fun keyCount(v: Any?): Int = when (v) {
        is JSONObject -> v.length()
        is JSONArray -> v.length()
        is String -> v.length
        else -> 0
    }

    /** 解析 #/$defs/X、#/definitions/X 这类本地 $ref；解析不到返回 null */
    private fun resolveRef(ref: Any?, root: Any?): JSONObject? {
        if (ref !is String || !ref.startsWith("#/")) return null
        var cur: Any? = root
        for (seg in ref.substring(2).split("/")) {
            val key = seg.replace("~1", "/").replace("~0", "~")
            if (cur !is JSONObject || !cur.has(key)) return null
            cur = cur.opt(key)
        }
        return cur as? JSONObject
    }

    private fun without(o: JSONObject, vararg keys: String): JSONObject {
        val out = JSONObject()
        val it = o.keys()
        while (it.hasNext()) {
            val k = it.next() as String
            if (k in keys) continue
            out.put(k, o.opt(k))
        }
        return out
    }

    private fun isNullType(t: Any?): Boolean {
        if (t == "null") return true
        if (t is JSONArray) {
            for (i in 0 until t.length()) if (t.opt(i) != "null") return false
            return true
        }
        return false
    }

    /**
     * 预展开 Gemini 不支持的组合语法（只在出现这些关键字时改写）：
     *  - $ref → 内联 $defs / definitions 中的定义（循环引用降级为 object，解析不到降级为 string）
     *  - allOf → 合并各分支的 properties / required / type
     *  - anyOf / oneOf（且无 type）→ 取第一个非 null 分支
     *  - type: ["string","null"] → 第一个非 null 类型
     */
    private fun flattenCombinators(schema: JSONObject, root: Any?, refStackIn: List<String>): Pair<JSONObject, List<String>> {
        var node = schema
        var refStack = refStackIn
        val ref = node.opt("\$ref")
        if (ref is String) {
            val rest = without(node, "\$ref")
            if (refStack.contains(ref)) {
                node = JSONObject().put("type", "object")
                if (Js.truthy(rest.opt("description"))) node.put("description", rest.opt("description"))
            } else {
                val target = resolveRef(ref, root)
                if (target == null) {
                    node = JSONObject().put("type", "string")
                        .put("description", Js.or(rest.opt("description"), "(Unresolved \$ref: $ref)"))
                } else {
                    refStack = refStack + ref
                    node = flattenCombinators(Js.spread(target, rest), root, refStack).first
                }
            }
        }
        val allOf = node.opt("allOf")
        if (allOf is JSONArray) {
            val merged = without(node, "allOf")
            for (i in 0 until allOf.length()) {
                val branch = allOf.opt(i)
                if (branch !is JSONObject) continue
                val b = flattenCombinators(branch, root, refStack).first
                val bp = b.opt("properties")
                if (bp is JSONObject) {
                    merged.put("properties", Js.spread(merged.opt("properties") as? JSONObject, bp))
                }
                val br = b.opt("required")
                if (br is JSONArray) {
                    val set = LinkedHashSet<Any?>()
                    val mr = merged.opt("required")
                    if (mr is JSONArray) for (j in 0 until mr.length()) set.add(mr.opt(j))
                    for (j in 0 until br.length()) set.add(br.opt(j))
                    merged.put("required", JSONArray(set.toList()))
                }
                for ((k, v) in entries(b)) {
                    if (k != "properties" && k != "required" && !merged.has(k)) merged.put(k, v)
                }
            }
            node = merged
        }
        val union = (node.opt("anyOf") as? JSONArray) ?: (node.opt("oneOf") as? JSONArray)
        if (union != null) {
            val rest = without(node, "anyOf", "oneOf")
            node = rest
            if (!rest.has("type")) {
                var pick: JSONObject? = null
                for (i in 0 until union.length()) {
                    val b = union.opt(i) as? JSONObject ?: continue
                    val fb = flattenCombinators(b, root, refStack).first
                    if (pick == null && !isNullType(fb.opt("type"))) pick = fb
                }
                if (pick != null) node = Js.spread(pick, rest)
            }
        }
        val t = node.opt("type")
        if (t is JSONArray) {
            var found: String? = null
            for (i in 0 until t.length()) {
                val x = t.opt(i)
                if (x is String && x != "null") { found = x; break }
            }
            node = Js.spread(node).put("type", found ?: "string")
        }
        return node to refStack
    }

    private fun defaultSchema(): JSONObject = JSONObject()
        .put("type", "OBJECT")
        .put("properties", JSONObject().put("reason", JSONObject().put("type", "STRING").put("description", "Execution parameter")))
        .put("required", JSONArray().put("reason"))

    @JvmStatic
    @JvmOverloads
    fun sanitizeSchema(schemaIn: Any?, root: Any? = schemaIn, refStackIn: List<String> = emptyList()): JSONObject {
        if (schemaIn !is JSONObject && schemaIn !is JSONArray) return defaultSchema()
        var schema: Any = schemaIn
        var refStack = refStackIn

        if (schema is JSONObject && (schema.has("\$ref") || schema.has("allOf") || schema.has("anyOf") || schema.has("oneOf") || schema.opt("type") is JSONArray)) {
            val r = flattenCombinators(schema, root, refStack)
            schema = r.first
            refStack = r.second
        }

        val sanitized = JSONObject()

        for ((key, value) in entries(schema)) {
            // 转换 const 为 enum
            if (key == "const") {
                sanitized.put("enum", JSONArray().put(value ?: JSONObject.NULL))
                continue
            }
            if (key !in ALLOWED_FIELDS) continue

            if (key == "type") {
                sanitized.put("type", toGoogleType(value))
            } else if (key == "properties" && (value is JSONObject || value is JSONArray)) {
                val props = JSONObject()
                val keys = entries(value).map { it.first }.sorted()
                val src = entries(value).toMap()
                for (pk in keys) props.put(pk, sanitizeSchema(src[pk], root, refStack))
                sanitized.put("properties", props)
            } else if (key == "items" && (value is JSONObject || value is JSONArray)) {
                if (value is JSONArray) {
                    val arr = JSONArray()
                    for (i in 0 until value.length()) arr.put(sanitizeSchema(value.opt(i), root, refStack))
                    sanitized.put("items", arr)
                } else {
                    sanitized.put("items", sanitizeSchema(value, root, refStack))
                }
            } else if (value is JSONObject) {
                sanitized.put(key, sanitizeSchema(value, root, refStack))
            } else {
                sanitized.put(key, value)
            }
        }

        // 过滤 required，确保仅包含 properties 中真实存在的字段名
        val req = sanitized.opt("required")
        if (req is JSONArray) {
            val props = sanitized.opt("properties")
            if (Js.truthy(props) && (props is JSONObject || props is JSONArray)) {
                val valid = entries(props).map { it.first }.toSet()
                val kept = JSONArray()
                for (i in 0 until req.length()) {
                    val r = req.opt(i)
                    if (r is String && r in valid) kept.put(r)
                }
                if (kept.length() == 0) sanitized.remove("required") else sanitized.put("required", kept)
            } else {
                sanitized.remove("required")
            }
        }

        // ARRAY 类型必须具备 items 字段
        if (sanitized.opt("type") == "ARRAY" && !Js.truthy(sanitized.opt("items"))) {
            sanitized.put("items", JSONObject().put("type", "STRING"))
        }

        // 默认补齐 type
        if (!Js.truthy(sanitized.opt("type"))) {
            sanitized.put("type", "OBJECT")
        }

        // 若为 OBJECT 但无 properties，补充占位属性
        if (sanitized.opt("type") == "OBJECT" && (!Js.truthy(sanitized.opt("properties")) || keyCount(sanitized.opt("properties")) == 0)) {
            sanitized.put("properties", JSONObject().put("_empty", JSONObject().put("type", "BOOLEAN").put("description", "Parameter presence flag")))
        }

        return sanitized
    }
}
