# Liora — Voice & Physical Memory Assistant

<div align="center">

<img src="docs/images/liora-banner.png" alt="Liora Header Banner" width="100%"/>

<br/><br/>

**Tell Liora where something goes once. Ask for it whenever you forget.**

*A voice-first physical memory assistant powered by AssemblyAI's Realtime Voice Agent API. Designed to keep track of everyday belongings, packed travel gear, lent equipment, and borrowed tools with natural conversation.*

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Render-003594?style=for-the-badge&logo=render&logoColor=white)](https://liora-0w0l.onrender.com)
[![GitHub Repo](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/faysaliqbal007/Liora)
[![AssemblyAI](https://img.shields.io/badge/Powered%20By-AssemblyAI%20Voice%20Agent-0052FF?style=for-the-badge&logo=assemblyai&logoColor=white)](https://www.assemblyai.com)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-016a61?style=for-the-badge)](LICENSE)

[**Live Demo**](https://liora-0w0l.onrender.com) • [**Interface Tour**](#interface-tour) • [**Voice Architecture**](#voice-pipeline--realtime-architecture) • [**Function Calling**](#function-calling--tool-specifications) • [**Local Setup**](#local-development--setup)

</div>

---

## Why Liora?

Most people misplace physical items not because they are disorganized, but because human working memory prioritizes whatever task is currently in front of us. When you tuck your passport into a desk drawer, drop your spare keys into a coat pocket, or lend a camera lens to a friend, you rarely want to open a cumbersome spreadsheet or inventory database to log it.

Traditional home inventory apps fail because their data entry friction is too high. You have to open the app, tap through forms, pick categories from dropdowns, and save. Because the entry friction is high, people stop maintaining them after two days.

Liora takes a completely different approach:

- **Zero-Friction Voice Capture**: When putting something away, you speak one sentence naturally — *"I packed my laptop charger inside the blue tech pouch"*.
- **Instant Conversational Recall**: Days or weeks later, you ask as if you are asking a roommate — *"Where is my charger?"* or *"Who currently has my camera?"*.
- **Confirmation Before Mutation**: Voice assistants should never modify physical records silently. Liora drafts changes on-screen and asks for confirmation before committing.
- **Client-Side Privacy**: Your physical inventory stays inside your browser (`localStorage`). No home locations or belongings lists are sent to any remote database.

---

## Interface Tour

The interface is built around a single-page responsive dashboard that integrates an active inventory ledger with an ambient conversational assistant.

### 1. Main Dashboard & Inventory Overview

The command center presents your physical inventory at a glance, featuring live metric counters, active belongings cards, granular location filtering, and the integrated conversational assistant panel.

![Main Dashboard Overview](docs/images/01-dashboard-overview.png)

- **Realtime Metric Counters**: Live counters for total tracked items, active items lent out to others, items currently borrowed from friends, and belongings stored safely at home.
- **Instant Category Filtering**: Switch between All belongings, items At Home, Packed luggage, Lent items, and Borrowed tools.
- **Location & Sorting Controls**: Filter items by specific rooms or compartments (*Bedroom desk top drawer*, *Key hook by entrance*, *Work desk laptop stand*) and sort by recent activity.
- **Transcript History**: The assistant panel preserves multi-turn dialogue with quick-suggestion chips and a demo data loader.

---

### 2. Realtime Voice Session (Active Microphone)

Liora features hands-free, low-latency voice interaction powered by AssemblyAI's Realtime Voice Agent API. When activated, the interface transitions seamlessly into a dedicated voice session.

![Realtime Voice Session](docs/images/02-voice-agent-chat.png)

- **Floating Voice Capsule**: When the microphone is toggled, a floating bottom capsule activates with live status updates (*"Listening to your voice..."*) and quick controls.
- **Animated Audio Equalizer**: Multi-frequency waveform bars animate in real time according to your microphone input.
- **Connection Indicator**: An active emerald badge confirms a full-duplex WebSocket connection to the streaming voice pipeline.
- **Natural Speech Pipeline**: You speak naturally, Liora answers with spoken audio, and full chat transcripts appear simultaneously.

---

### 3. Lent & Borrowed Management

Tracking physical items you've handed to others or borrowed from colleagues prevents forgotten gear and awkward reminders.

![Lent and Borrowed Ledger](docs/images/03-lent-borrowed.png)

- **Counterparty Attribution**: Clear status tags indicate whether an item is lent (*"With Sarah"*) or borrowed (*"Borrowed from Adam"*).
- **Due Date Badges**: Prominent visual due date tags alert you when an item is scheduled for return.
- **One-Click Return Resolution**: Clicking "Mark Returned" immediately restores the item to your home inventory and logs a return event.

---

### 4. Organized Storage & Packed Travel Gear

Whether packing bags for a trip or organizing closet storage boxes, Liora lets you see what is packed without opening bags.

![Storage and Packed Belongings](docs/images/04-organized-storage.png)

- **Compartment Precision**: High-resolution location labels allow deep nesting, such as *"Work desk laptop stand"*, *"Blue tech pouch"*, or *"Grey travel duffel"*.
- **Quick Re-assignment**: Belongings can be repacked into different travel bags or moved to other rooms with a single tap.
- **Single-Item Deletion**: Individual delete actions require deliberate confirmation, preventing accidental mass deletion.

---

### 5. Chronological Activity Audit Trail

Every confirmed move, packing event, loan, and return is permanently recorded in a timestamped chronological event ledger.

![Activity History Timeline](docs/images/05-activity-history.png)

- **Complete Audit Trail**: See the exact date, time, and prior location of every physical transfer.
- **Non-Destructive Memory**: Event history remains accessible even after items are returned or deleted, preserving a history of where your belongings have traveled.

---

### 6. Interactive Quick-Add Dialog

When speaking aloud is not convenient, the quick-add modal allows rapid manual cataloging with contextual presets.

![Add Item Modal Dialog](docs/images/06-add-item-modal.png)

- **Preset Action Categories**: Switch between *Put something somewhere*, *Pack something*, *Lend something*, or *Borrow something*.
- **Context-Aware Inputs**: Automatic label adjustments (e.g., changing "Where did you put it?" to "Who did you lend it to?" and revealing due-date pickers).

---

## Voice Pipeline & Realtime Architecture

Liora connects browser audio capture to AssemblyAI's Realtime Voice Agent API over a low-latency, full-duplex WebSocket bridge. The architecture is engineered around three primary requirements: sub-second latency, zero UI thread audio stutter, and complete isolation of private credentials.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Browser                                │
│                                                                         │
│   ┌─────────────────────┐                 ┌─────────────────────────┐   │
│   │   AudioContext      │                 │    pcm-processor.js     │   │
│   │  (16,000 Hz Input)  │ ──────────────> │  (AudioWorklet Thread)  │   │
│   └─────────────────────┘                 │  Float32 -> Int16 PCM   │   │
│                                           └────────────┬────────────┘   │
│                                                        │                │
│                                                        │ Raw 16kHz PCM  │
│   ┌─────────────────────┐                              │ Binary Stream  │
│   │ Local Storage State │                              ▼                │
│   │  (liora_items_v1)   │ <── Event Bus ──>  WebSocket Client Socket   │
│   └─────────────────────┘                                │              │
└──────────────────────────────────────────────────────────┼──────────────┘
                                                           │
                                                           │ Duplex WS
                                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Node.js Backend (server.mjs)                       │
│                                                                         │
│   - Holds ASSEMBLYAI_API_KEY securely in server environment             │
│   - Upstream WebSocket proxy to AssemblyAI Realtime Gateway             │
│   - Coordinates function calling tools with client-side state           │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   │ wss://api.assemblyai.com/...
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    AssemblyAI Realtime Voice Agent                      │
│                                                                         │
│   - Streaming Speech-to-Text (STT)                                      │
│   - Intent Classification & LLM Tool Orchestration                      │
│   - Streaming Text-to-Speech (TTS, 24kHz Linear PCM)                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1. Client-Side Audio Pipeline (`AudioWorklet`)

Standard web audio implementations often rely on `ScriptProcessorNode`, which runs on the main browser thread and drops audio frames whenever the DOM renders new chat bubbles or items. Liora uses a dedicated `AudioWorkletProcessor` defined in `pcm-processor.js`:

- Captures microphone input at 16,000 Hz sample rate via the Web Audio API.
- Converts 32-bit floating-point audio samples into raw linear 16-bit PCM chunks directly within an isolated audio rendering thread.
- Dispatches raw PCM byte buffers to the server socket without causing UI jitter or animation frame drops.

### 2. Duplex WebSocket Gateway (`server.mjs`)

The client browser never communicates directly with AssemblyAI, and the `ASSEMBLYAI_API_KEY` is never exposed to the client. Instead, `server.mjs` manages a bidirectional WebSocket proxy:

- When the user starts a voice session, the client establishes an authenticated WebSocket session with the Node backend.
- The server opens a secure upstream connection to AssemblyAI's Realtime Voice Agent endpoint (`wss://api.assemblyai.com/v2/realtime/ws`).
- Raw audio buffers stream upstream, while AssemblyAI's 24kHz synthesized speech and transcription events stream downstream to the browser.

### 3. Client-Side State & Function Calling

Because Liora prioritizes privacy, physical belongings data is stored solely in the browser's `localStorage` (`liora_items_v1`) rather than a remote database. Tool execution works through coordinated client-agent messaging:

- **`find_item(item)`**: Queries active belongings in local memory to answer location questions.
- **`list_items(status, detail)`**: Queries items filtered by state (`stored`, `packed`, `lent`, `borrowed`) or storage container.
- **`draft_change(item, action, detail, due_date)`**: Instead of mutating state blindly on voice input, the agent emits a structured draft event that displays a confirmation card in the UI.
- **`get_creator_info(topic)`**: Returns verified information about creator M M Faysal Iqbal and the project background.

### 4. Safety Guardrails & Data Boundaries

- **Zero-Knowledge Backend**: The Node.js proxy acts as a transient audio router. No item titles, storage locations, or user queries are logged to disk or stored in external databases.
- **Credential Isolation**: All upstream AssemblyAI handshakes occur strictly server-side.
- **No Mass Deletion**: The system prompt strictly disallows deleting all items at once, requiring deliberate user interaction on individual cards to remove records.
- **Hardened HTTP Headers**: The server enforces `nosniff`, `SAMEORIGIN` framing policies, and strict CORS boundaries.

---

## Function Calling & Tool Specifications

When AssemblyAI detects an intent in the user's speech, it emits a function call that executes against the user's local inventory state:

```json
{
  "name": "draft_change",
  "description": "Draft a change to an item's location or status. Never commit without user confirmation.",
  "parameters": {
    "type": "object",
    "properties": {
      "item": { "type": "string", "description": "The item name" },
      "action": { "type": "string", "enum": ["move", "pack", "lend", "borrow", "return"] },
      "detail": { "type": "string", "description": "Location, container, borrower, or lender" },
      "due_date": { "type": "string", "description": "Optional ISO date string for loans" }
    },
    "required": ["item", "action", "detail"]
  }
}
```

When a tool call is received:
1. The server receives the tool call event from AssemblyAI.
2. The server requests current state or dispatches the draft action to the client.
3. The client renders an on-screen confirmation card (*"Move Passport to Office Cabinet?"*).
4. Only upon explicit user confirmation is the `liora_items_v1` store updated and logged to history.

---

## Local Development & Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18.0 or later
- An [AssemblyAI API Key](https://www.assemblyai.com)

### 1. Clone the Repository

```bash
git clone https://github.com/faysaliqbal007/Liora.git
cd Liora
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and set your AssemblyAI API key:

```env
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
PORT=8000
```

### 3. Install & Start

```bash
npm install
npm start
```

Open your browser at:

```text
http://localhost:8000
```

---

## Verification & Quick Walkthrough

To verify the application locally or in the live demo:

1. **Load Pre-populated Belongings**: Click **"Demo Data"** in the top-right of the assistant panel to instantly load 7 realistic belongings and activity events.
2. **Start a Live Voice Session**:
   - Click the blue microphone button in the floating bottom console.
   - The status updates to *"Listening to your voice..."* with live equalizer animation.
3. **Test Retrieval Queries**:
   - Speak: *"Where is my passport?"* &rarr; Liora answers: *"Your Passport & Travel Docs are stored in the Bedroom desk top drawer."*
   - Speak: *"Who has my camera?"* &rarr; Liora answers: *"You lent your Sony A7 IV Camera to Sarah. It is scheduled to be returned by Sep 14, 2026."*
4. **Test State Changes**:
   - Speak: *"I packed my charger in my blue tech pouch."* &rarr; Liora drafts the change and updates the item to `PACKED`.
5. **Ask About the Creator**:
   - Speak: *"Who made you?"* &rarr; Liora invokes `get_creator_info` and shares verified information about creator **M M Faysal Iqbal**.

---

## Creator

<div align="center">

<img src="docs/images/liora-logo.png" alt="Liora Logo" width="90"/>

### **M M Faysal Iqbal**
*Computer Science and Engineering Student at Ahsanullah University of Science and Technology*  
Passionate about Cybersecurity, AI/ML, Robotics, and Ambient Voice Computing.

[![GitHub](https://img.shields.io/badge/GitHub-faysaliqbal007-181717?style=for-the-badge&logo=github)](https://github.com/faysaliqbal007)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-0A66C2?style=for-the-badge&logo=linkedin)](https://linkedin.com)

</div>

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <b>Built with precision by M M Faysal Iqbal • Powered by AssemblyAI Realtime Voice Agent API</b>
</div>
