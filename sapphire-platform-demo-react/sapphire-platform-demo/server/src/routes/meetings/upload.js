import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import { HttpsProxyAgent } from "https-proxy-agent";
import { prisma } from "../../prisma.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Configure OpenAI client with optional corporate proxy support
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const openaiOptions = { apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 };
if (proxyUrl) {
  try {
    openaiOptions.httpAgent = new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn("Failed to configure HTTPS proxy agent:", e?.message);
  }
}
const openai = new OpenAI(openaiOptions);
const USE_MOCK = String(process.env.MEETINGS_MOCK || '').toLowerCase() === '1' || String(process.env.MEETINGS_MOCK || '').toLowerCase() === 'true';

router.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    const filePath = req.file?.path;
    if (!filePath) return res.status(400).json({ error: "No file uploaded (field 'audio')" });

    const userEmail = req.headers["x-user-email"];
    if (!userEmail) return res.status(400).json({ error: "Missing x-user-email header" });

    const user = await prisma.user.findUnique({ where: { email: userEmail } });
    if (!user) {
      return res.status(400).json({ error: "Unknown user. Please ensure you are logged in and an email is set." });
    }

    if (USE_MOCK || !process.env.OPENAI_API_KEY) {
      const fakeTranscript = `Mock transcript for ${req.file.originalname}.`;
      const fakeSummary = `Mock summary generated locally for ${req.file.originalname}.`;
      const fakeActionItems = [
        'Review recording and capture notes',
        'Assign follow-ups to attendees'
      ];

      let meeting;
      try {
        meeting = await prisma.meeting.create({
          data: {
            userId: user.id,
            title: req.file.originalname.replace(/\.[^/.]+$/, ""),
            recordingUrl: `/uploads/${req.file.filename}`,
            transcript: fakeTranscript,
            summary: fakeSummary,
            actionItems: { create: fakeActionItems.map(text => ({ text })) },
          },
          include: { actionItems: true }
        });
      } catch {
        meeting = {
          id: null,
          userId: user.id,
          title: req.file.originalname.replace(/\.[^/.]+$/, ""),
          recordingUrl: `/uploads/${req.file.filename}`,
          transcript: fakeTranscript,
          summary: fakeSummary,
          actionItems: fakeActionItems.map((text, i) => ({ id: i + 1, text, status: 'pending' }))
        };
      }
      return res.json({ success: true, meeting, mock: true });
    }

    // 1) Transcribe audio to text
    let transcriptText = '';
    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
      });
      transcriptText = transcription.text;
    } catch (e) {
      if (USE_MOCK) {
        const fakeTranscript = `Mock transcript (fallback) for ${req.file.originalname}.`;
        transcriptText = fakeTranscript;
      } else {
        try { fs.unlinkSync(filePath); } catch {}
        return res.status(500).json({ error: `Transcription failed: ${e?.message || 'unknown error'}` });
      }
    }

    // 2) Summarize + extract action items (structured JSON)
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a meeting summarizer. Summarize the text and extract action items in JSON: {summary: '...', action_items: ['item1', 'item2', ...]}",
          },
          { role: "user", content: transcriptText },
        ],
        response_format: { type: "json_object" },
      });
    } catch (e) {
      if (USE_MOCK) {
        completion = { choices: [{ message: { content: JSON.stringify({ summary: `Mock summary for ${req.file.originalname}`, action_items: ['Follow up with team', 'Prepare minutes'] }) } }] };
      } else {
        try { fs.unlinkSync(filePath); } catch {}
        return res.status(500).json({ error: `Summarization failed: ${e?.message || 'unknown error'}` });
      }
    }

    const result = JSON.parse(completion.choices[0].message.content || '{}');
    const summaryText = result.summary || '';
    const actionItems = result.action_items || [];

    // 3) Store in DB (fallback to transient response if DB fails)
    let meeting;
    try {
      meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: req.file.originalname.replace(/\.[^/.]+$/, ""),
          recordingUrl: `/uploads/${req.file.filename}`,
          transcript: transcriptText,
          summary: summaryText,
          actionItems: {
            create: actionItems.map((item) => ({ text: item })),
          },
        },
        include: { actionItems: true },
      });
    } catch (e) {
      meeting = {
        id: null,
        userId: user.id,
        title: req.file.originalname.replace(/\.[^/.]+$/, ""),
        recordingUrl: `/uploads/${req.file.filename}`,
        transcript: transcriptText,
        summary: summaryText,
        actionItems: (actionItems || []).map((text, idx) => ({ id: idx + 1, text, status: 'pending' }))
      };
    }

    res.json({ success: true, meeting });
  } catch (err) {
    console.error("Meeting upload failed:", err);
    res.status(500).json({ error: `Failed to process meeting recording: ${err?.message || 'unknown error'}` });
  }
});

export default router;
