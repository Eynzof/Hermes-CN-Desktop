// Real-model group-chat smoke test.
//
// This script intentionally does not start a backend or copy credentials. Point
// it at an already-running, isolated Core dashboard and opt in explicitly:
//
//   E2E_REAL_GROUPCHAT=1 \
//   E2E_DASHBOARD_ORIGIN=http://127.0.0.1:9122 \
//   E2E_DASHBOARD_TOKEN=... \
//   node e2e/harness/groupchat-real-smoke.mjs
//
// Output is limited to sender order, response lengths, and boolean assertions;
// model text and credential values are never printed.

const enabled = process.env.E2E_REAL_GROUPCHAT === "1";
if (!enabled) {
  throw new Error("Refusing to run without E2E_REAL_GROUPCHAT=1");
}

const dashboardOrigin =
  process.env.E2E_DASHBOARD_ORIGIN || "http://127.0.0.1:9122";
const dashboardToken = process.env.E2E_DASHBOARD_TOKEN || "real-groupchat-e2e";
const createOnly = process.env.E2E_GROUPCHAT_CREATE_ONLY === "1";
const probeRoomId = process.env.E2E_GROUPCHAT_PROBE_ROOM || "";
const expectMissingRoom = process.env.E2E_EXPECT_ROOM_MISSING === "1";
const wsUrl = new URL("/api/ws", dashboardOrigin);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.searchParams.set("token", dashboardToken);

const profiles = [
  {
    name: "qa-real-planner",
    description: "方案提出者：只给出方案、假设和退出条件",
  },
  {
    name: "qa-real-critic",
    description: "红队审查者：只检查反例、遗漏和风险",
  },
  {
    name: "qa-real-synthesizer",
    description: "决策主持人：引用各方观点后形成结构化结论",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function ensureProfiles() {
  const headers = {
    Authorization: `Bearer ${dashboardToken}`,
    "Content-Type": "application/json",
  };
  const listResponse = await fetch(`${dashboardOrigin}/api/profiles`, { headers });
  assert(listResponse.ok, "profile list request failed");
  const body = await listResponse.json();
  const existing = new Set(
    (body.profiles || []).map((profile) => profile.name).filter(Boolean),
  );

  for (const profile of profiles) {
    if (existing.has(profile.name)) continue;
    const response = await fetch(`${dashboardOrigin}/api/profiles`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: profile.name,
        clone_from: "default",
        description: profile.description,
      }),
    });
    assert(response.ok, `failed to create profile ${profile.name}`);
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const events = [];
    const pending = new Map();
    let nextId = 1;
    let opened = false;

    socket.onopen = () => {
      opened = true;
      resolve({
        events,
        request(method, params = {}, timeoutMs = 180_000) {
          const id = `real-gc-${nextId++}`;
          return new Promise((requestResolve, requestReject) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              requestReject(new Error(`RPC timeout: ${method}`));
            }, timeoutMs);
            pending.set(id, {
              resolve(value) {
                clearTimeout(timeout);
                requestResolve(value);
              },
              reject(error) {
                clearTimeout(timeout);
                requestReject(error);
              },
            });
            socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    };
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
    socket.onclose = () => {
      if (!opened) reject(new Error("WebSocket closed before opening"));
    };
    socket.onmessage = (message) => {
      const frame = JSON.parse(message.data);
      if (frame.id != null && pending.has(String(frame.id))) {
        const request = pending.get(String(frame.id));
        pending.delete(String(frame.id));
        if (frame.error) {
          request.reject(new Error(frame.error.message || "JSON-RPC error"));
        } else {
          request.resolve(frame.result);
        }
        return;
      }
      if (frame.method === "event" && frame.params) {
        events.push(frame.params);
      }
    };
  });
}

function completedMessages(events, roomId, cursor) {
  return events
    .slice(cursor)
    .filter(
      (event) =>
        event.session_id === roomId && event.type === "message.complete",
    )
    .map((event) => ({
      sender: event.payload?.sender_name,
      text: String(event.payload?.text || ""),
    }));
}

async function main() {
  const startedAt = Date.now();
  await ensureProfiles();
  const api = await connect();

  try {
    if (probeRoomId) {
      let missing = false;
      try {
        const info = await api.request("groupchat.info", { room_id: probeRoomId });
        missing = Boolean(info?.error);
      } catch (error) {
        if (String(error?.message || error).includes("group room not found")) {
          missing = true;
        } else {
          throw error;
        }
      }
      assert(
        expectMissingRoom ? missing : !missing,
        expectMissingRoom
          ? "room unexpectedly survived Core restart"
          : "room was unexpectedly missing",
      );
      console.log(
        JSON.stringify({
          level: "L3",
          room_id: probeRoomId,
          room_missing: missing,
          classification: missing ? "EXPECTED_LIMIT" : "PASS",
        }),
      );
      return;
    }

    const room = await api.request("groupchat.create", {
      members: profiles.map((profile) => profile.name),
      title: "真实模型隔离协作验证",
    });
    assert(room?.room_id, "groupchat.create did not return room_id");
    if (createOnly) {
      console.log(
        JSON.stringify({
          level: "L3_SETUP",
          room_id: room.room_id,
          members: profiles.map((profile) => profile.name),
        }),
      );
      return;
    }

    let cursor = api.events.length;
    await api.request("groupchat.submit", {
      room_id: room.room_id,
      text: [
        "这是隔离的群聊路由测试。不要调用任何工具。",
        "每位成员请先原样写出自己的成员名，再用一句话给出与你职责一致的观点。",
      ].join(""),
    });
    const firstTurn = completedMessages(api.events, room.room_id, cursor);
    assert(firstTurn.length === 3, "first turn must contain three replies");
    assert(
      JSON.stringify(firstTurn.map((message) => message.sender)) ===
        JSON.stringify(profiles.map((profile) => profile.name)),
      "first-turn sender order must match room member order",
    );
    assert(
      firstTurn.every((message) => message.text.includes(message.sender)),
      "each member must identify itself in its own reply",
    );

    cursor = api.events.length;
    await api.request("groupchat.submit", {
      room_id: room.room_id,
      text: [
        "@qa-real-synthesizer 不要调用任何工具。",
        "请结合上一轮内容作两点总结，回答中必须逐字包含 ",
        "qa-real-planner 和 qa-real-critic 两个成员名，并分别复述他们的一条观点。",
      ].join(""),
    });
    const secondTurn = completedMessages(api.events, room.room_id, cursor);
    assert(secondTurn.length === 1, "targeted turn must contain one reply");
    assert(
      secondTurn[0].sender === "qa-real-synthesizer",
      "targeted turn must be owned by the synthesizer",
    );
    assert(
      secondTurn[0].text.includes("qa-real-planner") &&
        secondTurn[0].text.includes("qa-real-critic"),
      "synthesizer must reference both previous speakers",
    );

    cursor = api.events.length;
    await api.request("groupchat.submit", {
      room_id: room.room_id,
      text: [
        "@qa-real-critic @qa-real-planner 不要调用任何工具。",
        "各自只回答“路由顺序确认”，并保留自己的成员名。",
      ].join(""),
    });
    const thirdTurn = completedMessages(api.events, room.room_id, cursor);
    assert(
      JSON.stringify(thirdTurn.map((message) => message.sender)) ===
        JSON.stringify(["qa-real-planner", "qa-real-critic"]),
      "multiple mentions must still follow room member order",
    );

    const debateSteps = [
      {
        target: "qa-real-planner",
        prompt:
          "@qa-real-planner 不要调用任何工具。提出初版方案，回答必须逐字包含 PLAN-V1。",
        required: ["PLAN-V1"],
      },
      {
        target: "qa-real-critic",
        prompt:
          "@qa-real-critic 不要调用任何工具。审查上一轮方案，回答必须逐字包含 PLAN-V1 和 qa-real-planner。",
        required: ["PLAN-V1", "qa-real-planner"],
      },
      {
        target: "qa-real-planner",
        prompt:
          "@qa-real-planner 不要调用任何工具。结合上一轮批评修订方案，回答必须逐字包含 REVISION-V2 和 qa-real-critic。",
        required: ["REVISION-V2", "qa-real-critic"],
      },
      {
        target: "qa-real-synthesizer",
        prompt:
          "@qa-real-synthesizer 不要调用任何工具。总结方案、批评与修订并决策，回答必须逐字包含 DECISION-FINAL、qa-real-planner 和 qa-real-critic。",
        required: [
          "DECISION-FINAL",
          "qa-real-planner",
          "qa-real-critic",
        ],
      },
    ];
    const debateSenders = [];
    for (const step of debateSteps) {
      cursor = api.events.length;
      await api.request("groupchat.submit", {
        room_id: room.room_id,
        text: step.prompt,
      });
      const turn = completedMessages(api.events, room.room_id, cursor);
      assert(
        turn.length === 1 && turn[0].sender === step.target,
        "four-round debate routed to the wrong member",
      );
      assert(
        step.required.every((marker) => turn[0].text.includes(marker)),
        "four-round debate lost a required prior-turn marker",
      );
      debateSenders.push(turn[0].sender);
    }

    console.log(
      JSON.stringify({
        level: "L2",
        room_id: room.room_id,
        first_senders: firstTurn.map((message) => message.sender),
        second_senders: secondTurn.map((message) => message.sender),
        third_senders: thirdTurn.map((message) => message.sender),
        debate_senders: debateSenders,
        first_reply_lengths: firstTurn.map((message) => message.text.length),
        second_reply_length: secondTurn[0].text.length,
        referenced_both_previous_speakers: true,
        four_round_context_ok: true,
        elapsed_ms: Date.now() - startedAt,
      }),
    );
  } finally {
    api.close();
  }
}

main().catch((error) => {
  console.error(`REAL_GROUPCHAT_E2E_FAILED: ${error.message}`);
  process.exit(1);
});
