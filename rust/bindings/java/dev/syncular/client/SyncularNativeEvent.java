package dev.syncular.client;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SyncularNativeEvent {
    public final String rawJson;
    public final long eventSeq;
    public final String kind;
    public final String commandId;
    public final String clientCommitId;
    public final Long durationMs;
    public final Long droppedCount;
    public final Boolean resyncRequired;
    public final List<String> tables;
    public final List<String> queries;
    public final List<ChangedRow> changedRows;

    private SyncularNativeEvent(
        String rawJson,
        long eventSeq,
        String kind,
        String commandId,
        String clientCommitId,
        Long durationMs,
        Long droppedCount,
        Boolean resyncRequired,
        List<String> tables,
        List<String> queries,
        List<ChangedRow> changedRows
    ) {
        this.rawJson = rawJson;
        this.eventSeq = eventSeq;
        this.kind = kind;
        this.commandId = commandId;
        this.clientCommitId = clientCommitId;
        this.durationMs = durationMs;
        this.droppedCount = droppedCount;
        this.resyncRequired = resyncRequired;
        this.tables = Collections.unmodifiableList(tables);
        this.queries = Collections.unmodifiableList(queries);
        this.changedRows = Collections.unmodifiableList(changedRows);
    }

    public static SyncularNativeEvent fromJson(String json) {
        Object parsed = new JsonParser(json).parse();
        if (!(parsed instanceof Map)) {
            throw new IllegalArgumentException("Syncular native event JSON must be an object");
        }
        Map<?, ?> event = (Map<?, ?>) parsed;
        return new SyncularNativeEvent(
            json,
            longValue(event.get("event_seq"), 0L),
            stringValue(event.get("kind")),
            stringValue(event.get("command_id")),
            stringValue(event.get("client_commit_id")),
            nullableLong(event.get("duration_ms")),
            nullableLong(event.get("droppedCount")),
            nullableBoolean(event.get("resyncRequired")),
            stringList(event.get("tables")),
            stringList(event.get("queries")),
            changedRows(event.get("changedRows"))
        );
    }

    private static List<ChangedRow> changedRows(Object value) {
        if (!(value instanceof List)) return Collections.emptyList();
        List<?> rows = (List<?>) value;
        List<ChangedRow> out = new ArrayList<>(rows.size());
        for (Object row : rows) {
            if (row instanceof Map) {
                out.add(ChangedRow.fromMap((Map<?, ?>) row));
            }
        }
        return out;
    }

    private static List<String> stringList(Object value) {
        if (!(value instanceof List)) return Collections.emptyList();
        List<?> values = (List<?>) value;
        List<String> out = new ArrayList<>(values.size());
        for (Object item : values) {
            String string = stringValue(item);
            if (string != null) out.add(string);
        }
        return out;
    }

    private static String stringValue(Object value) {
        return value instanceof String ? (String) value : null;
    }

    private static Long nullableLong(Object value) {
        return value instanceof Number ? Long.valueOf(((Number) value).longValue()) : null;
    }

    private static long longValue(Object value, long fallback) {
        Long parsed = nullableLong(value);
        return parsed == null ? fallback : parsed.longValue();
    }

    private static Boolean nullableBoolean(Object value) {
        return value instanceof Boolean ? (Boolean) value : null;
    }

    public static final class ChangedRow {
        public final String table;
        public final String rowId;
        public final String operation;
        public final List<String> changedFields;
        public final List<String> crdtFields;
        public final String commitId;
        public final Long commitSeq;
        public final String subscriptionId;
        public final Long serverVersion;

        private ChangedRow(
            String table,
            String rowId,
            String operation,
            List<String> changedFields,
            List<String> crdtFields,
            String commitId,
            Long commitSeq,
            String subscriptionId,
            Long serverVersion
        ) {
            this.table = table;
            this.rowId = rowId;
            this.operation = operation;
            this.changedFields = Collections.unmodifiableList(changedFields);
            this.crdtFields = Collections.unmodifiableList(crdtFields);
            this.commitId = commitId;
            this.commitSeq = commitSeq;
            this.subscriptionId = subscriptionId;
            this.serverVersion = serverVersion;
        }

        private static ChangedRow fromMap(Map<?, ?> row) {
            return new ChangedRow(
                stringValue(row.get("table")),
                stringValue(row.get("rowId")),
                stringValue(row.get("operation")),
                stringList(row.get("changedFields")),
                stringList(row.get("crdtFields")),
                stringValue(row.get("commitId")),
                nullableLong(row.get("commitSeq")),
                stringValue(row.get("subscriptionId")),
                nullableLong(row.get("serverVersion"))
            );
        }
    }

    private static final class JsonParser {
        private final String input;
        private int index;

        JsonParser(String input) {
            this.input = input;
        }

        Object parse() {
            Object value = readValue();
            skipWhitespace();
            if (index != input.length()) {
                throw error("unexpected trailing JSON");
            }
            return value;
        }

        private Object readValue() {
            skipWhitespace();
            if (index >= input.length()) throw error("unexpected end of JSON");
            char c = input.charAt(index);
            if (c == '"') return readString();
            if (c == '{') return readObject();
            if (c == '[') return readArray();
            if (c == 't') return readLiteral("true", Boolean.TRUE);
            if (c == 'f') return readLiteral("false", Boolean.FALSE);
            if (c == 'n') return readLiteral("null", null);
            if (c == '-' || Character.isDigit(c)) return readNumber();
            throw error("unexpected JSON value");
        }

        private Map<String, Object> readObject() {
            expect('{');
            Map<String, Object> object = new LinkedHashMap<>();
            skipWhitespace();
            if (peek('}')) {
                index++;
                return object;
            }
            while (true) {
                String key = readString();
                skipWhitespace();
                expect(':');
                object.put(key, readValue());
                skipWhitespace();
                if (peek('}')) {
                    index++;
                    return object;
                }
                expect(',');
                skipWhitespace();
            }
        }

        private List<Object> readArray() {
            expect('[');
            List<Object> array = new ArrayList<>();
            skipWhitespace();
            if (peek(']')) {
                index++;
                return array;
            }
            while (true) {
                array.add(readValue());
                skipWhitespace();
                if (peek(']')) {
                    index++;
                    return array;
                }
                expect(',');
            }
        }

        private String readString() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (index < input.length()) {
                char c = input.charAt(index++);
                if (c == '"') return out.toString();
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                if (index >= input.length()) throw error("unterminated escape");
                char escaped = input.charAt(index++);
                switch (escaped) {
                    case '"':
                    case '\\':
                    case '/':
                        out.append(escaped);
                        break;
                    case 'b':
                        out.append('\b');
                        break;
                    case 'f':
                        out.append('\f');
                        break;
                    case 'n':
                        out.append('\n');
                        break;
                    case 'r':
                        out.append('\r');
                        break;
                    case 't':
                        out.append('\t');
                        break;
                    case 'u':
                        if (index + 4 > input.length()) throw error("invalid unicode escape");
                        out.append((char) Integer.parseInt(input.substring(index, index + 4), 16));
                        index += 4;
                        break;
                    default:
                        throw error("invalid escape");
                }
            }
            throw error("unterminated string");
        }

        private Object readNumber() {
            int start = index;
            if (peek('-')) index++;
            while (index < input.length() && Character.isDigit(input.charAt(index))) index++;
            boolean floating = false;
            if (peek('.')) {
                floating = true;
                index++;
                while (index < input.length() && Character.isDigit(input.charAt(index))) index++;
            }
            if (peek('e') || peek('E')) {
                floating = true;
                index++;
                if (peek('+') || peek('-')) index++;
                while (index < input.length() && Character.isDigit(input.charAt(index))) index++;
            }
            String number = input.substring(start, index);
            return floating ? Double.valueOf(number) : Long.valueOf(number);
        }

        private Object readLiteral(String literal, Object value) {
            if (!input.startsWith(literal, index)) {
                throw error("invalid literal");
            }
            index += literal.length();
            return value;
        }

        private void expect(char expected) {
            if (index >= input.length() || input.charAt(index) != expected) {
                throw error("expected '" + expected + "'");
            }
            index++;
        }

        private boolean peek(char expected) {
            return index < input.length() && input.charAt(index) == expected;
        }

        private void skipWhitespace() {
            while (index < input.length()) {
                char c = input.charAt(index);
                if (c != ' ' && c != '\n' && c != '\r' && c != '\t') return;
                index++;
            }
        }

        private IllegalArgumentException error(String message) {
            return new IllegalArgumentException(message + " at byte " + index);
        }
    }
}
