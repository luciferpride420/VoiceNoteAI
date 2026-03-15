import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { google } from 'googleapis';
import session from 'express-session';
import dotenv from 'dotenv';
import multer from 'multer';
import OpenAI from 'openai';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

// Initialize OpenAI only if the key is present
let openai: OpenAI | null = null;
const getOpenAI = () => {
  if (!openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
};

// Initialize Gemini for fallback
let gemini: GoogleGenAI | null = null;
const getGemini = () => {
  if (!gemini) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is required for fallback");
    }
    gemini = new GoogleGenAI({ apiKey: key });
  }
  return gemini;
};

const upload = multer({ dest: "uploads/" });

const app = express();
const PORT = 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));

// Setup session for OAuth state
app.use(session({
  secret: 'voicenote-ai-secret',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: true,
    sameSite: 'none',
    httpOnly: true,
  }
}));

// OAuth2 Client setup
const getOAuth2Client = (req: express.Request) => {
  const redirectUri = `${process.env.APP_URL || `http://localhost:${PORT}`}/api/auth/callback`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
};

// --- API Routes ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 1. Get Google OAuth URL
app.get('/api/auth/url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google OAuth not configured' });
  }
  
  const oauth2Client = getOAuth2Client(req);
  const scopes = ['https://www.googleapis.com/auth/calendar.events'];
  
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  
  res.json({ url });
});

// 2. OAuth Callback
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing code');
  }

  try {
    const oauth2Client = getOAuth2Client(req);
    const { tokens } = await oauth2Client.getToken(code);
    
    // In a real app, store tokens in a database associated with the user.
    // Here we just pass the access token back to the client via a postMessage.
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', token: '${tokens.access_token}' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Authentication failed');
  }
});

// 3. Add Event to Calendar
app.post('/api/calendar/events', async (req, res) => {
  const { token, event } = req.body;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: event.title,
        description: event.description,
        start: { dateTime: event.start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: event.end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      }
    });
    
    res.json({ success: true, event: response.data });
  } catch (error: any) {
    console.error('Calendar API error:', error);
    res.status(500).json({ error: error.message || 'Failed to add event' });
  }
});


// --- OpenAI Routes ---

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const openaiClient = getOpenAI();
    
    // Whisper requires a file stream with a known extension
    const originalPath = req.file.path;
    const extension = req.file.mimetype.split('/')[1]?.split(';')[0] || 'webm';
    const tempFilePath = `${originalPath}.${extension}`;
    
    fs.renameSync(originalPath, tempFilePath);

    const transcription = await openaiClient.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-1",
    });

    // Cleanup
    fs.unlinkSync(tempFilePath);

    res.json({ text: transcription.text });
  } catch (error: any) {
    console.error("Transcription error:", error);
    
    // Fallback to Gemini on 429 Quota Exceeded
    if (error.status === 429 || (error.message && error.message.toLowerCase().includes('quota'))) {
      console.log("OpenAI quota exceeded, falling back to Gemini...");
      try {
        const geminiClient = getGemini();
        // The file might have been unlinked if it failed after whisper, but usually it fails during the call
        // Let's reconstruct the path just in case
        const originalPath = req.file!.path;
        const extension = req.file!.mimetype.split('/')[1]?.split(';')[0] || 'webm';
        const tempFilePath = `${originalPath}.${extension}`;
        
        if (fs.existsSync(tempFilePath)) {
          const base64Audio = fs.readFileSync(tempFilePath).toString('base64');
          const response = await geminiClient.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: req.file!.mimetype,
                    data: base64Audio,
                  },
                },
                { text: 'Please transcribe all spoken words in this audio recording. Return only the spoken words exactly as heard. No timestamps, no speaker labels, no formatting.' },
              ],
            },
            config: {
              temperature: 0,
              maxOutputTokens: 8192,
            },
          });
          
          fs.unlinkSync(tempFilePath);
          return res.json({ text: response.text || '' });
        }
      } catch (geminiError: any) {
        console.error("Gemini fallback error:", geminiError);
        // Clean up if it exists
        const tempFilePath = `${req.file!.path}.${req.file!.mimetype.split('/')[1]?.split(';')[0] || 'webm'}`;
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        return res.status(500).json({ error: "OpenAI quota exceeded and Gemini fallback failed: " + geminiError.message });
      }
    }

    // Clean up if it exists
    if (req.file) {
      const tempFilePath = `${req.file.path}.${req.file.mimetype.split('/')[1]?.split(';')[0] || 'webm'}`;
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
    
    res.status(500).json({ error: error.message || "Failed to transcribe audio" });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) {
      return res.status(400).json({ error: "No transcript provided" });
    }

    const openaiClient = getOpenAI();

    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an AI meeting analyst. Analyze this meeting transcript and respond ONLY with valid JSON in this exact structure:
{
  "summary": "2-3 sentence summary of the meeting",
  "key_topics": ["topic1", "topic2", "topic3"],
  "participants": ["name/role mentioned"],
  "action_items": [
    {"task": "description", "owner": "person or team", "due": "date or timeframe if mentioned"}
  ],
  "decisions": ["decision 1", "decision 2"],
  "calendar_events": [
    {
      "title": "Event title",
      "description": "brief description",
      "date": "YYYY-MM-DD",
      "time": "HH:MM",
      "duration_minutes": 60
    }
  ]
}
Only include calendar_events if specific meetings, deadlines, or events with dates were mentioned.
If no date is mentioned for an event, use tomorrow's date as default.`
        },
        {
          role: "user",
          content: `TRANSCRIPT:\n${transcript}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error("Empty response from OpenAI");

    res.json(JSON.parse(content));
  } catch (error: any) {
    console.error("Analysis error:", error);
    
    // Fallback to Gemini on 429 Quota Exceeded
    if (error.status === 429 || (error.message && error.message.toLowerCase().includes('quota'))) {
      console.log("OpenAI quota exceeded, falling back to Gemini...");
      try {
        const geminiClient = getGemini();
        const response = await geminiClient.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `You are an AI meeting analyst. Analyze this meeting transcript and respond ONLY with valid JSON in this exact structure:
{
  "summary": "2-3 sentence summary of the meeting",
  "key_topics": ["topic1", "topic2", "topic3"],
  "participants": ["name/role mentioned"],
  "action_items": [
    {"task": "description", "owner": "person or team", "due": "date or timeframe if mentioned"}
  ],
  "decisions": ["decision 1", "decision 2"],
  "calendar_events": [
    {
      "title": "Event title",
      "description": "brief description",
      "date": "YYYY-MM-DD",
      "time": "HH:MM",
      "duration_minutes": 60
    }
  ]
}
Only include calendar_events if specific meetings, deadlines, or events with dates were mentioned.
If no date is mentioned for an event, use tomorrow's date as default.

TRANSCRIPT:
${req.body.transcript}`,
          config: {
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                key_topics: { type: Type.ARRAY, items: { type: Type.STRING } },
                participants: { type: Type.ARRAY, items: { type: Type.STRING } },
                action_items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      task: { type: Type.STRING },
                      owner: { type: Type.STRING },
                      due: { type: Type.STRING },
                    },
                  },
                },
                decisions: { type: Type.ARRAY, items: { type: Type.STRING } },
                calendar_events: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      description: { type: Type.STRING },
                      date: { type: Type.STRING },
                      time: { type: Type.STRING },
                      duration_minutes: { type: Type.NUMBER },
                    },
                  },
                },
              },
            },
          },
        });
        
        const content = response.text;
        if (!content) throw new Error("Empty response from Gemini");
        return res.json(JSON.parse(content));
      } catch (geminiError: any) {
        console.error("Gemini fallback error:", geminiError);
        return res.status(500).json({ error: "OpenAI quota exceeded and Gemini fallback failed: " + geminiError.message });
      }
    }

    res.status(500).json({ error: error.message || "Failed to analyze transcript" });
  }
});

// --- Vite Middleware ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
