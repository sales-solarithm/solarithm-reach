import { GoogleGenAI, Type } from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { companyName, city, state, status, notes, callAttempts } = body;

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'MY_GEMINI_API_KEY') {
      // Deterministic fallback script if API key is not configured in preview
      return NextResponse.json({
        openingHook: `Namaste, speaking with the Energy / Electrical Head at ${companyName}? We are executing C&I captive rooftop & open-access solar installations across ${city || state || 'your industrial cluster'} cutting HT DISCOM tariffs by 42–55%.`,
        estimatedCapacityKw: '650 kWp – 1,200 kWp (Industrial HT Feeder)',
        keyValueProp: `Zero-capex OPEX PPA at ₹4.10/kWh or accelerated 3.1-year payback CAPEX turnkey EPC with TopCon 580Wp bifacial modules.`,
        objectionRebuttal: `If roof load capacity is a concern, our structural engineering team runs a complimentary STAAD-Pro audit and offers non-penetrating standing-seam clamps with a 25-year leak-free warranty.`,
      });
    }

    const prompt = `You are a Senior C&I Solar EPC Sales Strategist at Solarithm Design & Engineering in India.
Generate a concise, high-converting telecalling script and sizing brief for:
- Company: ${companyName}
- Location: ${city || 'Industrial Area'}, ${state || 'India'}
- Current Lead Status: ${status}
- Prior Call Attempts: ${callAttempts || 0}
- Field Notes: ${notes || 'Standard commercial/industrial HT prospect'}

Return a structured JSON object with:
1. openingHook: A sharp 2-sentence Indian C&I telecalling opening line mentioning local DISCOM tariff savings.
2. estimatedCapacityKw: Estimated solar plant kWp/MWp capacity and roof/ground configuration based on company profile.
3. keyValueProp: CAPEX payback and OPEX PPA tariff highlight tailored to this industry.
4. objectionRebuttal: Best response to their most likely objection.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            openingHook: { type: Type.STRING },
            estimatedCapacityKw: { type: Type.STRING },
            keyValueProp: { type: Type.STRING },
            objectionRebuttal: { type: Type.STRING },
          },
          required: ['openingHook', 'estimatedCapacityKw', 'keyValueProp', 'objectionRebuttal'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json(
      {
        openingHook: `Good morning, connecting from Solarithm Design & Engineering regarding HT industrial solar tariff reduction for your facility.`,
        estimatedCapacityKw: '500 kWp – 1.5 MWp Turnkey EPC',
        keyValueProp: '3.2-year ROI with 40% accelerated depreciation benefit and net-metering approval.',
        objectionRebuttal: 'We handle complete CEIG, GEDA/MSEDCL/DISCOM net-metering approvals end-to-end.',
        errorNote: error instanceof Error ? error.message : 'Fallback brief loaded',
      },
      { status: 200 }
    );
  }
}
