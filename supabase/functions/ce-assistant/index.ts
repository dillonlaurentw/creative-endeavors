// Creative Endeavors assistant: the server half of the chat in /manage/.
//
// It holds the Anthropic API key (a Supabase secret, ANTHROPIC_API_KEY),
// checks the caller is a Creative Endeavors admin, and relays one turn of the
// conversation to Claude with a fixed set of instructions and tools. The
// tools themselves run in the admin's browser (manage/manage.js), through
// the same database permissions as the rest of /manage/, so this function
// never touches the data and needs no service key. Anything that changes the
// public website (publishing, website words, deleting) is only proposed by
// Claude; the admin approves it with a button.
//
// Deploy: supabase functions deploy ce-assistant
// Secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MODEL = "claude-opus-5-5";
const ALLOWED_ORIGINS = ["https://creativeendeavors.xyz", "https://www.creativeendeavors.xyz", "http://localhost:8766"];
const MAX_BODY_BYTES = 4_000_000;

const SYSTEM = `You are the assistant inside the admin area of Creative Endeavors (creativeendeavors.xyz), an independent think tank for creatives that brings people together through community, curated experiences and entrepreneurial initiatives. The person talking to you is one of its admins. Your job is to make running the platform effortless: turn their notes, lists and photos into tidy records, and write well.

What you can do with your tools:
- Find, create and update events (upcoming and past), with a one-line summary and a story.
- Find, create and update people, record who was at which event and in what role, and connect people.
- Suggest who should meet whom.
- Attach photos the admin shared in the chat to an event (and choose the cover) or to a person.
- Propose changes that go live on the public website: publishing or unpublishing an event, changing website words, deleting things. These need the admin's approval: call the tool, and the admin sees an Approve button. Never claim something is live until the tool result says it was approved.

How to work:
- Act, don't interrogate. If the admin gives you enough to make a sensible draft, make it, then tell them what you did and what's still missing. Ask a question only when a wrong guess would be costly (for example, which of two people with the same name they mean).
- Always search before creating, so you don't make duplicates of people or events. Use people's full names as given.
- New events are saved as drafts. Offer to publish when the event looks ready (it has a name, date, place, summary, and for past events a story and ideally photos).
- Dates: the admin's local date, time and time zone are given at the start of their message. Resolve relative dates ("last Friday", "next Thursday at 7") from that. Pass times as local "YYYY-MM-DDTHH:MM". If no time is given for an event, use 19:00 and say so.
- Writing for the website: write in Creative Endeavors' voice: warm, clear, confident, specific, no hype, no clichés, no exclamation marks, no emoji. Short paragraphs separated by a blank line. A summary is one sentence. A past-event story is usually 2 to 5 short paragraphs built from the admin's notes and what you can see in the photos; never invent quotes, names, numbers or facts that aren't in the notes or clearly visible. If notes are thin, write less rather than padding, and say what detail would make it better.
- Private information (emails, phone numbers, private notes, who attended) is for admins only and must never go into a summary or story.
- When you finish, reply briefly in plain language: what you created or changed, with names, and any suggested next step. No markdown headings or tables; short lists are fine.`;

// The tools Claude can call. They run in the browser (manage/manage.js).
const str = (description: string) => ({ type: "string", description });
const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_people",
    description: "Find people by name, email, what they do, city, discipline or tag. Returns up to 15 matches with ids. Use before creating anyone.",
    input_schema: { type: "object", properties: { query: str("Words to match; empty returns the most recently added people.") }, required: ["query"] },
  },
  {
    name: "get_person",
    description: "Full details of one person, including their events and connections.",
    input_schema: { type: "object", properties: { person_id: str("The person's id.") }, required: ["person_id"] },
  },
  {
    name: "save_person",
    description: "Create a person, or update one when person_id is given. Only the fields you pass are changed. links are full URLs; an Instagram handle like @maya becomes a link.",
    input_schema: {
      type: "object",
      properties: {
        person_id: str("Omit to create a new person."),
        name: str("Full name."),
        email: str("Email address."),
        phone: str("Phone number."),
        headline: str("What they do, e.g. 'Founder of Studio Nine, designer'."),
        city: str("City."),
        bio: str("A few sentences about them."),
        links: { type: "array", items: { type: "string" }, description: "Website, Instagram or other links." },
        disciplines: { type: "array", items: { type: "string" }, description: "e.g. design, film, music." },
        tags: { type: "array", items: { type: "string" }, description: "e.g. founder, speaker." },
        notes: str("Private admin notes. Replaces existing notes, so include anything worth keeping."),
      },
    },
  },
  {
    name: "search_events",
    description: "Find events by words in the title, place or city. Returns up to 15 matches with ids, dates and whether each is published.",
    input_schema: {
      type: "object",
      properties: { query: str("Words to match; empty lists recent events."), when: { type: "string", enum: ["any", "upcoming", "past"], description: "Filter by time." } },
      required: ["query"],
    },
  },
  {
    name: "get_event",
    description: "Full details of one event: summary, story, photos, who was there, and whether it's on the website.",
    input_schema: { type: "object", properties: { event_id: str("The event's id.") }, required: ["event_id"] },
  },
  {
    name: "save_event",
    description: "Create an event (always as a draft), or update one when event_id is given. Only the fields you pass are changed. Cannot publish; use propose_publish for that.",
    input_schema: {
      type: "object",
      properties: {
        event_id: str("Omit to create a new event."),
        title: str("Name of the event."),
        starts_at: str("Local start, 'YYYY-MM-DDTHH:MM'."),
        ends_at: str("Local end, 'YYYY-MM-DDTHH:MM' (optional)."),
        venue: str("Place, e.g. 'The Loft'."),
        city: str("City."),
        kind: str("Dinner, salon, workshop, talk, studio visit, opening…"),
        description: str("One-sentence summary for the events list."),
        story: str("Past: what happened. Upcoming: what to expect. Paragraphs separated by a blank line."),
        link: str("RSVP or details link (https://…)."),
      },
    },
  },
  {
    name: "add_people_to_event",
    description: "Record who was at (or is part of) an event. People are matched by person_id, or by exact name; anyone not found is created. Roles: host, speaker, performer, artist, attendee, volunteer, partner.",
    input_schema: {
      type: "object",
      properties: {
        event_id: str("The event's id."),
        people: {
          type: "array",
          items: {
            type: "object",
            properties: { person_id: str("If known."), name: str("Full name."), email: str("Optional."), role: { type: "string", enum: ["host", "speaker", "performer", "artist", "attendee", "volunteer", "partner"] } },
            required: ["role"],
          },
        },
      },
      required: ["event_id", "people"],
    },
  },
  {
    name: "connect_people",
    description: "Connect two people. kind: met, collaborated, introduced, mentor or friends. Optionally the event where it happened.",
    input_schema: {
      type: "object",
      properties: {
        person_a: str("Person id."), person_b: str("Person id."),
        kind: { type: "string", enum: ["met", "collaborated", "introduced", "mentor", "friends"] },
        note: str("Optional short note."), event_id: str("Optional event id."),
      },
      required: ["person_a", "person_b", "kind"],
    },
  },
  {
    name: "connect_everyone_at_event",
    description: "Connect everyone recorded at an event with each other as 'met'. Returns how many new connections were made.",
    input_schema: { type: "object", properties: { event_id: str("The event's id.") }, required: ["event_id"] },
  },
  {
    name: "suggest_connections",
    description: "People a person isn't connected to yet but should probably meet (shared events or interests), best first.",
    input_schema: { type: "object", properties: { person_id: str("The person's id.") }, required: ["person_id"] },
  },
  {
    name: "attach_photos",
    description: "Attach photos the admin shared in this chat (ids like 'photo-1') to an event's gallery, optionally choosing the cover; or set one as a person's photo.",
    input_schema: {
      type: "object",
      properties: {
        photo_ids: { type: "array", items: { type: "string" }, description: "Ids of shared photos, e.g. ['photo-1','photo-2']." },
        event_id: str("Attach to this event."),
        cover_photo_id: str("Which photo becomes the event's cover."),
        person_id: str("Or: set the first photo as this person's photo."),
      },
      required: ["photo_ids"],
    },
  },
  {
    name: "propose_publish",
    description: "Ask the admin to approve putting an event on the website (publish: true) or taking it off (publish: false). Returns whether they approved.",
    input_schema: { type: "object", properties: { event_id: str("The event's id."), publish: { type: "boolean" } }, required: ["event_id", "publish"] },
  },
  {
    name: "propose_website_words",
    description: "Ask the admin to approve new website words. keys: home.lede (homepage headline), home.intro (homepage paragraphs, blank line between), home.epigraph (quote at the foot of every page), events.lede, events.intro. Returns whether they approved.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", enum: ["home.lede", "home.intro", "home.epigraph", "events.lede", "events.intro"] }, value: str("The new words.") },
      required: ["key", "value"],
    },
  },
  {
    name: "propose_delete",
    description: "Ask the admin to approve deleting an event or a person. Returns whether they approved.",
    input_schema: { type: "object", properties: { event_id: str("Event to delete."), person_id: str("Person to delete.") } },
  },
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  // Only Creative Endeavors admins, checked with their own sign-in.
  const auth = req.headers.get("authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: isAdmin, error: adminError } = await supabase.rpc("ce_is_admin");
  if (adminError || isAdmin !== true) return reply(403, { error: "Admins only." });

  if (!Deno.env.get("ANTHROPIC_API_KEY")) return reply(503, { error: "The assistant isn't set up yet: add the ANTHROPIC_API_KEY secret in Supabase." });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "This conversation is too long. Start a new one." });
  let messages: Anthropic.Beta.BetaMessageParam[];
  try {
    const body = JSON.parse(raw);
    messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > 400) throw new Error("bad");
  } catch {
    return reply(400, { error: "Send {\"messages\": [...]}." });
  }

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });
    return reply(200, { content: response.content, stop_reason: response.stop_reason, stop_details: response.stop_details ?? null });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return reply(429, { error: "The assistant is busy. Try again in a minute." });
    if (err instanceof Anthropic.BadRequestError) { console.error("bad request", err.message); return reply(400, { error: "The assistant couldn't read that conversation. Start a new one." }); }
    if (err instanceof Anthropic.AuthenticationError) return reply(503, { error: "The assistant's API key isn't valid. Check the ANTHROPIC_API_KEY secret in Supabase." });
    if (err instanceof Anthropic.APIError) { console.error("anthropic", err.status, err.message); return reply(502, { error: "The assistant is having trouble. Try again shortly." }); }
    console.error(err);
    return reply(500, { error: "Something went wrong." });
  }
});
