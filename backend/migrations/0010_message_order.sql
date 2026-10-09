-- Mesajların sırası created_at-ın dəqiqliyinə (eyni mikrosaniyə) bağlı olmasın: monoton ardıcıllıq
ALTER TABLE messages ADD COLUMN seq BIGSERIAL;
CREATE INDEX idx_messages_conversation_seq ON messages (conversation_id, seq);
