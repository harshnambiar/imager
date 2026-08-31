import { GoogleGenAI } from "@google/genai";
import { createWorker } from "tesseract.js";
import fs from "fs/promises";
import path from "path";
import "dotenv/config";

const key = process.env.VITE_API_KEY;

const ai = new GoogleGenAI({
  apiKey: key, // or hardcode temporarily for testing
});

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

(async () => {
  try {
    console.log("Running Tesseract.js...");
    const text = await extractTextWithTesseract("./samples/s1.png"); 
    console.log("\n===== Extracted Text =====\n");
    console.log(text);
  } catch (err) {
    console.error("Error:", err.message);
  }
})();
