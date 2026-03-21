/**
 * Ethiopian name generation.
 * Uses Groq LLM when GROQ_API_KEY is set; falls back to a local name pool.
 */

import Groq from 'groq-sdk';

const FIRST_NAMES = [
  'Abebe','Tigist','Haile','Mekdes','Dawit','Selamawit','Yonas','Hiwot',
  'Samuel','Bethlehem','Daniel','Rahel','Biruk','Liya','Solomon','Meron',
  'Yared','Tsion','Nahom','Eden','Kidus','Sara','Abel','Martha','Natnael',
  'Fiker','Mihret','Robel','Beza','Eyob','Selam','Tewodros','Zerihun',
  'Hanna','Meseret','Yordanos','Betelhem','Amsalu','Lulseged','Miriam',
  'Kalkidan','Abreham','Sosina','Henok','Saron','Yohannes','Mahlet',
  'Tesfaye','Amanuel','Wubet','Bereket','Nardos','Leul','Bezawit',
];

const LAST_NAMES = [
  'Tadesse','Bekele','Negash','Haile','Girma','Tesfaye','Alemu','Worku',
  'Mekonnen','Gebre','Ayele','Tekle','Desta','Woldemariam','Kebede','Assefa',
  'Tilahun','Mulugeta','Getachew','Lemma','Amare','Fikre','Bogale','Mengesha',
  'Tsegaye','Demeke','Engida','Hailu','Kassahun','Legesse','Nigatu','Shiferaw',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

let _groq: Groq | null = null;
function groqClient(): Groq | null {
  if (!process.env.GROQ_API_KEY) return null;
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

export async function generateEthiopianName(
  log?: (m: string) => void,
): Promise<{ firstName: string; lastName: string }> {
  const client = groqClient();

  if (client) {
    try {
      const resp = await client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content:
              'You generate Ethiopian person names. Reply with ONLY the first name and last name ' +
              'separated by a single space. No punctuation. No explanation. No extra words.',
          },
          { role: 'user', content: 'Give me one unique Ethiopian full name.' },
        ],
        max_tokens: 20,
        temperature: 1.1,
      });
      const raw = (resp.choices[0]?.message?.content ?? '').trim().replace(/[^a-zA-Z\s]/g, '');
      const parts = raw.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const firstName = parts[0];
        const lastName  = parts.slice(1).join('');
        log?.(`[groq] Generated name: ${firstName} ${lastName}`);
        return { firstName, lastName };
      }
    } catch (err) {
      log?.(`[groq] Name generation failed (${err}) — using local pool`);
    }
  }

  return { firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES) };
}
