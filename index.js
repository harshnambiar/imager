import { GoogleGenAI } from "@google/genai";
import { createWorker } from "tesseract.js";
import { createCanvas, loadImage } from "canvas";
import fs from "fs/promises";
import { writeFileSync, readFileSync } from "fs";
import path from "path";
import "dotenv/config";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";

const key = process.env.VITE_API_KEY;

const ai = new GoogleGenAI({
  apiKey: key, // or hardcode temporarily for testing
});

// ------------------ Regex patterns for DPDP sensitive data ------------------
const PATTERNS = [
  // Email
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,

  // Indian Mobile
  /(?:\+91[\s-]*)?[6-9]\d{9}/g,

  // GSTIN (more flexible)
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/gi,
  /\b\d{2}[A-Z0-9]{13}\b/gi, // fallback for OCR errors

  // PAN
  /\b[A-Z]{5}\d{4}[A-Z]\b/gi,

  // IFSC
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,

  // Account numbers
  /\b\d{9,18}\b/g,
];

const PATTERNS_PDF = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,
  mobile: /(?:\+91[\s-]*)?[6-9]\d{9}/g,
  gstin: [
    /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/gi,
    /\b\d{2}[A-Z0-9]{13}\b/gi, // fallback for OCR errors
  ],
  pan: /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
  ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,
  account: /\b\d{9,18}\b/g,
};


function redactSensitiveDataPdf(text) {
  if (!text || typeof text !== "string") {
    return {
      email: [],
      mobile: [],
      gstin: [],
      pan: [],
      ifsc: [],
      account: [],
      body: "",
    };
  }

  const found = {
    email: new Set(),
    mobile: new Set(),
    gstin: new Set(),
    pan: new Set(),
    ifsc: new Set(),
    account: new Set(),
  };

  // Collect all matches (use Sets to keep them unique)
  for (const [type, pattern] of Object.entries(PATTERNS_PDF)) {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];

    for (const regex of patterns) {
      // Reset lastIndex just in case
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        found[type].add(match[0].trim());
      }
    }
  }

  // Build the redacted body
  let body = text;

  // Longer matches first to avoid partial overwrites
  const allSensitive = [
    ...found.email,
    ...found.mobile,
    ...found.gstin,
    ...found.pan,
    ...found.ifsc,
    ...found.account,
  ].sort((a, b) => b.length - a.length);

  for (const value of allSensitive) {
    // Escape special regex characters in the value
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    body = body.replace(re, "[REDACTED]");
  }

  return {
    email: [...found.email],
    mobile: [...found.mobile],
    gstin: [...found.gstin],
    pan: [...found.pan],
    ifsc: [...found.ifsc],
    account: [...found.account],
    body: body.trim(),
  };
}


function containsSensitiveData(text) {
  if (!text) return false;
  return PATTERNS.some((regex) => {
    regex.lastIndex = 0;
    return regex.test(text);
  });
}

async function redactInvoice(inputPath, outputPath = null) {
  if (!outputPath) {
    const ext = path.extname(inputPath);
    outputPath = inputPath.replace(ext, `_redacted${ext}`);
  }

  console.log("Loading image...");
  const image = await loadImage(inputPath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  console.log("Running OCR...");
  const worker = await createWorker("eng");

  const { data } = await worker.recognize(inputPath, {}, { blocks: true });
  await worker.terminate();

  // Get all lines
  const lines =
    data.blocks
      ?.flatMap((block) => block.paragraphs || [])
      ?.flatMap((paragraph) => paragraph.lines || []) || [];

  console.log(`Found ${lines.length} lines`);

  let redactedCount = 0;

  for (const line of lines) {
    const lineText = line.text?.trim() || "";

    // Check if the full line contains sensitive data
    if (containsSensitiveData(lineText)) {
      const { x0, y0, x1, y1 } = line.bbox;

      // Add padding and black out the entire line
      const paddingX = 6;
      const paddingY = 3;

      ctx.fillStyle = "#000000";
      ctx.fillRect(
        x0 - paddingX,
        y0 - paddingY,
        x1 - x0 + paddingX * 2,
        y1 - y0 + paddingY * 2
      );

      redactedCount++;
      console.log(`Redacted line: ${lineText.substring(0, 80)}...`);
    }
  }

  // Save
  const buffer = canvas.toBuffer("image/png");
  writeFileSync(outputPath, buffer);

  console.log(`\nDone! Redacted ${redactedCount} lines.`);
  console.log(`Saved → ${outputPath}`);
  return outputPath;
}

/**
 * Extract text from a JPG or PNG file using Gemini
 * @param {string} filePath - Path to the .jpg / .jpeg / .png file
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromImageWithAi(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let mimeType;

  if (ext === ".jpg" || ext === ".jpeg") {
    mimeType = "image/jpeg";
  } else if (ext === ".png") {
    mimeType = "image/png";
  } else {
    throw new Error("Only JPG and PNG files are supported");
  }

  // Read file and convert to base64
  const imageBuffer = await fs.readFile(filePath);
  const base64Image = imageBuffer.toString("base64");

  const prompt = `
Extract all the text from this scanned document image.
Include both printed text and any handwritten text.
Preserve the original layout and line breaks as much as possible.
Return only the extracted text, nothing else.
`;

console.log(key);
  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash", // or "gemini-3.7-flash" / "gemini-2.5-flash" depending on availability
    contents: [
      {
        inlineData: {
          mimeType,
          data: base64Image,
        },
      },
      { text: prompt },
    ],
  });

  return response.text?.trim() || "";
}

async function extractTextWithTesseract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) {
    throw new Error("Only JPG and PNG files are supported");
  }

  // Create a worker (loads English by default)
  const worker = await createWorker("eng");

  try {
    const {
      data: { text },
    } = await worker.recognize(filePath);

    return text.trim();
  } finally {
    // Always terminate the worker to free memory
    await worker.terminate();
  }
}

async function extractTextGeneric(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (![".jpg", ".jpeg", ".png", ".pdf"].includes(ext)) {
    throw new Error("Only JPG, PNG and PDF files are supported");
  }

  // ========== IMAGE ==========
  if (ext !== ".pdf") {
    const worker = await createWorker("eng");
    try {
      const { data: { text } } = await worker.recognize(filePath);
      return text.trim();
    } finally {
      await worker.terminate();
    }
  }

  // ========== PDF ==========
  const data = new Uint8Array(readFileSync(filePath));
  const pdf = await pdfjs.getDocument({ data }).promise;

  let fullText = "";
  const ocrWorker = await createWorker("eng");

  try {
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);

      // 1. Try to extract real text layer
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => item.str)
        .join(" ")
        .trim();

      // Heuristic: if there's decent amount of text, treat as digital PDF
      if (pageText.length > 30) {
        fullText += `\n\n--- Page ${pageNum} (Text Layer) ---\n${pageText}`;
        continue;
      }

      // 2. Very little text → treat as scanned page → use Tesseract
      console.log(`Page ${pageNum} looks scanned. Running OCR...`);

      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext("2d");

      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      const { data: { text } } = await ocrWorker.recognize(canvas);
      fullText += `\n\n--- Page ${pageNum} (OCR) ---\n${text}`;
    }
  } finally {
    await ocrWorker.terminate();
  }

  return redactSensitiveDataPdf(fullText.trim());
}


/*
(async () => {
  try {
    const text = await extractTextFromImageWithAi("./samples/s1.png");
    console.log(text);
  } catch (err) {
    console.error("Error:", err.message);
  }
})();
*/

/*(async () => {
  try {
    console.log("Running Tesseract.js...");
    const text = await extractTextWithTesseract("./samples/s1.png"); 
    console.log("\n===== Extracted Text =====\n");
    console.log(text);
  } catch (err) {
    console.error("Error:", err.message);
  }
})();
*/

// ------------------ Redaction Example ------------------
/*(async () => {
  try {
    const inputFile = "./samples/s4.png";
    await redactInvoice(inputFile);
  } catch (err) {
    console.error("Error:", err.message);
  }
})();
*/


(async () => {
  try {
    const inputFile = "./samples/i1.pdf";
    const text = await extractTextGeneric(inputFile);
    console.log("\n======== Extracted Text: ========\n");
    console.log(text);
  } catch (err) {
    console.error("Error:", err.message);
  }
})();
