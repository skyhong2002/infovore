package tw.skyhong.infovore.health

/**
 * A small strict JSON reader for tests (org.json is only a stub in JVM unit tests). Objects become
 * maps, arrays lists, numbers [Double], so two documents can be compared field by field.
 */
internal object MiniJson {
    fun parse(text: String): Any? = Parser(text).run {
        val value = value()
        skipSpace()
        require(index == text.length) { "trailing data at $index" }
        value
    }

    private class Parser(val text: String) {
        var index = 0

        fun skipSpace() {
            while (index < text.length && text[index].isWhitespace()) index++
        }

        fun value(): Any? {
            skipSpace()
            require(index < text.length) { "unexpected end" }
            return when (val c = text[index]) {
                '{' -> obj()
                '[' -> array()
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) number() else error("unexpected '$c' at $index")
            }
        }

        private fun obj(): Map<String, Any?> {
            index++
            val result = linkedMapOf<String, Any?>()
            skipSpace()
            if (text[index] == '}') return result.also { index++ }
            while (true) {
                skipSpace()
                val key = string()
                skipSpace()
                expect(':')
                require(key !in result) { "duplicate key $key" }
                result[key] = value()
                skipSpace()
                if (text[index] == ',') index++ else break
            }
            expect('}')
            return result
        }

        private fun array(): List<Any?> {
            index++
            val result = mutableListOf<Any?>()
            skipSpace()
            if (text[index] == ']') return result.also { index++ }
            while (true) {
                result += value()
                skipSpace()
                if (text[index] == ',') index++ else break
            }
            expect(']')
            return result
        }

        private fun string(): String {
            expect('"')
            val out = StringBuilder()
            while (true) {
                val c = text[index++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> when (val e = text[index++]) {
                        '"', '\\', '/' -> out.append(e)
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> out.append(text.substring(index, index + 4).toInt(16).toChar()).also { index += 4 }
                        else -> error("bad escape \\$e")
                    }
                    c < ' ' -> error("control character in string")
                    else -> out.append(c)
                }
            }
        }

        private fun number(): Double {
            val start = index
            while (index < text.length && (text[index].isDigit() || text[index] in "+-.eE")) index++
            return text.substring(start, index).toDouble()
        }

        private fun literal(word: String, value: Any?): Any? {
            require(text.startsWith(word, index)) { "bad literal at $index" }
            index += word.length
            return value
        }

        private fun expect(c: Char) {
            require(index < text.length && text[index] == c) { "expected '$c' at $index" }
            index++
        }
    }
}
