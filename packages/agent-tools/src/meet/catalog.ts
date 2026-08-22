import { z } from "zod";
import { registry } from "../registry.js";
import { objectSchema } from "../catalog.js";
import { meetJoin, meetLeave, meetSay, meetSetup, meetStatus, meetTranscript } from "./tools.js";
import type { ToolEntry } from "../types.js";

export function registerMeetTools(): void {
  const tools: ToolEntry[] = [
    {
      name: "meet_join",
      toolset: "google_meet",
      description:
        "Join a Google Meet call as a headless virtual participant and capture live captions into a transcript.",
      emoji: "🎥",
      tags: ["google_meet"],
      schema: objectSchema({
        url: z.string().describe("Google Meet URL (https://meet.google.com/abc-defg-hij)"),
        guest_name: z.string().optional().describe("Display name for the virtual participant"),
        duration_minutes: z.number().optional().describe("Auto-leave after N minutes"),
        mode: z.enum(["transcribe", "realtime"]).default("transcribe").describe("transcribe only in v1"),
        headed: z.boolean().optional().describe("Show browser window for debugging"),
      }),
      handler: meetJoin,
    },
    {
      name: "meet_status",
      toolset: "google_meet",
      description: "Check the status of the active Google Meet bot.",
      emoji: "🎥",
      tags: ["google_meet"],
      schema: objectSchema({
        meeting_id: z.string().optional().describe("Meeting id; uses active meeting if omitted"),
      }),
      handler: meetStatus,
    },
    {
      name: "meet_transcript",
      toolset: "google_meet",
      description: "Read the live-caption transcript of an active or recent Google Meet.",
      emoji: "🎥",
      tags: ["google_meet"],
      schema: objectSchema({
        meeting_id: z.string().optional().describe("Meeting id; uses active meeting if omitted"),
        last: z.number().optional().describe("Return the last N lines"),
      }),
      handler: meetTranscript,
    },
    {
      name: "meet_leave",
      toolset: "google_meet",
      description: "Leave the active Google Meet and clean up the bot process.",
      emoji: "🎥",
      tags: ["google_meet"],
      schema: objectSchema({
        meeting_id: z.string().optional().describe("Meeting id; uses active meeting if omitted"),
        reason: z.string().optional().describe("Reason for leaving"),
      }),
      handler: meetLeave,
    },
    {
      name: "meet_say",
      toolset: "google_meet",
      description:
        "Speak a line in the active Google Meet. Realtime speech is deferred in v1; returns ok=false with a reason.",
      emoji: "🎥",
      tags: ["google_meet"],
      schema: objectSchema({
        meeting_id: z.string().optional(),
        text: z.string().describe("Text to speak"),
      }),
      handler: meetSay,
    },
    {
      name: "meet_setup",
      toolset: "google_meet",
      description: "Preflight check for the Google Meet bot (Chromium install).",
      emoji: "🎥",
      tags: ["google_meet"],
      schema: objectSchema({}),
      handler: meetSetup,
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}

// Auto-register on module import so the global catalog contains the tools.
registerMeetTools();
