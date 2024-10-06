-- Create the conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  customer_name TEXT,
  customer_availability TEXT,
  special_notes TEXT,
  transcript TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create an index on session_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);

-- Add any additional tables or indexes here if needed in the future