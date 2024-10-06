import Fastify from "fastify";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";
import pkg from 'pg';
const { Pool } = pkg;
import path from 'path';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key. Please set it in the .env file.");
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `You are a friendly and professional AI phone assistant for Dustin's super awesome AI. Your role is to engage with the caller in a natural, conversational manner. Remember these key points:

1. The caller has already been greeted and asked for their name. Start by acknowledging their name once they provide it.
2. Be helpful and attentive, answering any questions they may have.
3. Keep your responses concise but complete.
4. If you're unsure about something, it's okay to say so and offer alternatives.
5. Aim to resolve their query or assist them to the best of your ability.
6. Maintain a warm, approachable tone throughout the conversation.

Remember, you're here to make the caller feel heard and assisted. Engage with them as a helpful, knowledgeable friend would.`;
const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

// Session management
const sessions = new Map();

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
    "response.content.done",
    "rate_limits.updated",
    "response.done",
    "input_audio_buffer.committed",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.speech_started",
    "session.created",
    "response.text.done",
    "conversation.item.input_audio_transcription.completed",
];

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:HQLmCOaEt3R5@ep-proud-cloud-a57m4ms8.us-east-2.aws.neon.tech/neondb?sslmode=require'
});

// Function to initialize the database
async function initDatabase() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(process.cwd(), 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Error initializing database schema:', error);
  } finally {
    client.release();
  }
}

// Call the initDatabase function when the server starts
initDatabase();

// Root Route
fastify.get("/", async (request, reply) => {
    reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Update the /incoming-call route
fastify.all("/incoming-call", async (request, reply) => {
    console.log("Incoming call");

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>
                                  Welcome to Dustin's super awesome AI! We're here to help with any questions you might have. 
                                  Feel free to ask about anything – we're all ears and ready to assist. 
                                  To get started, could you please tell me your name?
                              </Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection, req) => {
        console.log("Client connected");

        const sessionId =
            req.headers["x-twilio-call-sid"] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || {
            transcript: "",
            streamSid: null,
            userName: null,
        };
        sessions.set(sessionId, session);

        const openAiWs = new WebSocket(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1",
                },
            },
        );

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: "session.update",
                session: {
                    turn_detection: { type: "server_vad" },
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: {
                        model: "whisper-1",
                    },
                },
            };

            console.log(
                "Sending session update:",
                JSON.stringify(sessionUpdate),
            );
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on("open", () => {
            console.log("Connected to the OpenAI Realtime API");
            setTimeout(sendSessionUpdate, 250);
        });

        // Modify the OpenAI WebSocket message handler
        openAiWs.on("message", (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // User message transcription handling
                if (
                    response.type ===
                    "conversation.item.input_audio_transcription.completed"
                ) {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`User (${sessionId}): ${userMessage}`);
                }

                // Agent message handling
                if (response.type === "response.done") {
                    const agentMessage =
                        response.response.output[0]?.content?.find(
                            (content) => content.transcript,
                        )?.transcript || "Agent message not found";
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                if (response.type === "session.updated") {
                    console.log("Session updated successfully:", response);
                }

                if (
                    response.type === "response.audio.delta" &&
                    response.delta
                ) {
                    const audioDelta = {
                        event: "media",
                        streamSid: session.streamSid,
                        media: {
                            payload: Buffer.from(
                                response.delta,
                                "base64",
                            ).toString("base64"),
                        },
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error(
                    "Error processing OpenAI message:",
                    error,
                    "Raw message:",
                    data,
                );
            }
        });

        // Handle incoming messages from Twilio
        connection.on("message", (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case "media":
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: "input_audio_buffer.append",
                                audio: data.media.payload,
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case "start":
                        session.streamSid = data.start.streamSid;
                        console.log(
                            "Incoming stream has started",
                            session.streamSid,
                        );
                        break;
                    default:
                        console.log("Received non-media event:", data.event);
                        break;
                }
            } catch (error) {
                console.error(
                    "Error parsing message:",
                    error,
                    "Message:",
                    message,
                );
            }
        });

        // Handle connection close and log transcript
        connection.on("close", async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log(`Client disconnected (${sessionId}).`);
            console.log("Full Transcript:");
            console.log(session.transcript);

            await processTranscriptAndSend(session.transcript, sessionId);

            // Clean up the session
            sessions.delete(sessionId);
        });

        // Handle WebSocket close and errors
        openAiWs.on("close", () => {
            console.log("Disconnected from the OpenAI Realtime API");
        });

        openAiWs.on("error", (error) => {
            console.error("Error in the OpenAI WebSocket:", error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});

// Function to make ChatGPT API completion call with structured outputs
async function makeChatGPTCompletion(transcript) {
    console.log("Starting ChatGPT API call...");
    try {
        const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "gpt-4o-2024-08-06",
                    messages: [
                        {
                            role: "system",
                            content:
                                "Extract customer details: name, availability, and any special notes from the transcript.",
                        },
                        { role: "user", content: transcript },
                    ],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "customer_details_extraction",
                            schema: {
                                type: "object",
                                properties: {
                                    customerName: { type: "string" },
                                    customerAvailability: { type: "string" },
                                    specialNotes: { type: "string" },
                                },
                                required: [
                                    "customerName",
                                    "customerAvailability",
                                    "specialNotes",
                                ],
                            },
                        },
                    },
                }),
            },
        );

        console.log("ChatGPT API response status:", response.status);
        const data = await response.json();
        console.log(
            "Full ChatGPT API response:",
            JSON.stringify(data, null, 2),
        );
        return data;
    } catch (error) {
        console.error("Error making ChatGPT completion call:", error);
        throw error;
    }
}

// Main function to extract and send customer details
async function processTranscriptAndSend(transcript, sessionId = null) {
    console.log(`Starting transcript processing for session ${sessionId}...`);
    try {
        // Make the ChatGPT completion call
        const result = await makeChatGPTCompletion(transcript);

        console.log(
            "Raw result from ChatGPT:",
            JSON.stringify(result, null, 2),
        );

        if (
            result.choices &&
            result.choices[0] &&
            result.choices[0].message &&
            result.choices[0].message.content
        ) {
            try {
                const parsedContent = JSON.parse(
                    result.choices[0].message.content,
                );
                console.log(
                    "Parsed content:",
                    JSON.stringify(parsedContent, null, 2),
                );

                if (parsedContent) {
                    // Store the parsed content in the PostgreSQL database
                    const client = await pool.connect();
                    try {
                        await client.query(
                            `INSERT INTO conversations (session_id, customer_name, customer_availability, special_notes, transcript)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [sessionId, parsedContent.customerName, parsedContent.customerAvailability, parsedContent.specialNotes, transcript]
                        );
                        console.log(
                            "Extracted and stored customer details:",
                            parsedContent,
                        );
                    } finally {
                        client.release();
                    }
                } else {
                    console.error(
                        "Unexpected JSON structure in ChatGPT response",
                    );
                }
            } catch (parseError) {
                console.error(
                    "Error parsing JSON from ChatGPT response:",
                    parseError,
                );
            }
        } else {
            console.error("Unexpected response structure from ChatGPT API");
        }
    } catch (error) {
        console.error("Error in processTranscriptAndSend:", error);
    }
}

// Add a cleanup function to close the database connection when the server stops
process.on('SIGINT', async () => {
  console.log('Closing database connection pool...');
  await pool.end();
  process.exit(0);
});