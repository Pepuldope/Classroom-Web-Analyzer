import { jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

export default async function handler() {
  return jsonResponse({
    hasRefreshTokens: !!process.env.GOOGLE_CLIENT_SECRET,
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY || null,
  });
}
