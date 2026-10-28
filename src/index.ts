import "dotenv/config";
// 👆 Loads .env file — reads PORT and AUTH_COOKIE

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// 👆 Same McpServer class we used in the local MCP server

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// 👆 NEW transport — instead of StdioServerTransport, we use HTTP
// This is what makes our server "remote" — it listens on a real HTTP port

import express from "express";
// 👆 Express — creates our HTTP server
// Every MCP request comes in as a POST to /mcp

import { z } from "zod";
// 👆 Zod — defines and validates our tool input shapes

// ─────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────
// Our existing mcp-server uses Stdio transport — only Claude Desktop
// on your local machine can talk to it.
//
// This server uses Streamable HTTP transport — it runs as a real
// web server. Any MCP-compatible client anywhere can call it.
//
// Think of it like:
//   Local MCP  = a USB cable (direct connection, one machine)
//   Remote MCP = a WiFi router (anyone with the URL can connect)
// ─────────────────────────────────────────────────────────────────


// ── STEP 1: Create the Express app ───────────────────────────────
const app = express();
app.use(express.json());
// 👆 express.json() — parses incoming JSON request bodies
// Without this, req.body would be undefined

const PORT = process.env.PORT || 3001;
// 👆 Port to listen on
// Default 3001 so it doesn't clash with TaskFlow on 3000


// ── STEP 2: Tool + Resource + Prompt registration factory ─────────
// In stateless mode, we create a fresh McpServer + transport per request.
// This function registers all our tools, resources AND prompts onto any given server instance.
// We keep the logic in ONE place so it doesn't get duplicated.
//
// WHY PER-REQUEST?
// StreamableHTTPServerTransport in stateless mode is designed to be
// ephemeral — one transport handles exactly one request lifecycle.
// If you reuse the same transport, it's already in a "connected" state
// when the next initialize arrives, causing HTTP 500.
function buildMcpServer(): McpServer {
    const mcpServerInstance = new McpServer({
        name: "remote-mcp-server",
        version: "1.0.0",
    });


    // ── TOOL 1: get_location ─────────────────────────────────────────
    // Returns the hardcoded location we're working from
    // In a real app, you'd get this from the user's profile or GPS
    mcpServerInstance.tool(
        "get_location",
        // 👆 Tool name — what the AI client calls

        "Get the current location. Returns city, country, and coordinates.",
        // 👆 Description — AI uses this to decide WHEN to call this tool

        {},
        // 👆 No inputs needed — location is hardcoded for this learning example

        async () => {
            // Return location details as a structured object
            const locationDetails = {
                city: "Chennai",
                country: "India",
                latitude: 13.0827,
                longitude: 80.2707,
                // 👆 Chennai's real coordinates
                timezone: "Asia/Kolkata",
            };

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(locationDetails, null, 2),
                        // 👆 Return as formatted JSON — AI can read and use it
                    }
                ]
            };
        }
    );


    // ── TOOL 2: get_weather ──────────────────────────────────────────
    // Fetches real current weather for any coordinates
    // Uses Open-Meteo — a free weather API, no key required
    mcpServerInstance.tool(
        "get_weather",

        "Get the current weather for a location using latitude and longitude coordinates. Returns temperature, wind speed, and weather condition.",

        {
            latitude: z.number()
                .describe("Latitude of the location (e.g. 13.0827 for Chennai)"),
            longitude: z.number()
                .describe("Longitude of the location (e.g. 80.2707 for Chennai)"),
            city: z.string()
                .optional()
                .describe("City name — used only for display in the response"),
            // 👆 city is optional — just makes the response more readable
            // The actual weather lookup uses lat/lon only
        },

        async (weatherInputs) => {
            // Build the Open-Meteo API URL with the provided coordinates
            // current= tells the API which weather variables we want right now
            const weatherApiUrl =
                `https://api.open-meteo.com/v1/forecast` +
                `?latitude=${weatherInputs.latitude}` +
                `&longitude=${weatherInputs.longitude}` +
                `&current=temperature_2m,wind_speed_10m,weather_code` +
                `&timezone=auto`;
            // 👆 temperature_2m  = temperature at 2 metres above ground (standard)
            // 👆 wind_speed_10m  = wind speed at 10 metres (standard measurement height)
            // 👆 weather_code    = WMO code (0 = clear sky, 61 = rain, etc.)
            // 👆 timezone=auto   = auto-detect timezone from coordinates

            // Fetch weather data from Open-Meteo (no API key needed)
            let weatherApiResponse: Response;
            try {
                weatherApiResponse = await fetch(weatherApiUrl);
            } catch (fetchError) {
                console.error("Fetch failed:", fetchError);
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: String(fetchError) }) }]
                };
            }

            if (!weatherApiResponse.ok) {
                // If the API call fails, return a helpful error message
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: "Failed to fetch weather data",
                                status: weatherApiResponse.status,
                            })
                        }
                    ]
                };
            }

            const weatherData = await weatherApiResponse.json() as {
                current: {
                    temperature_2m: number;
                    wind_speed_10m: number;
                    weather_code: number;
                    time: string;
                };
                current_units: {
                    temperature_2m: string;
                    wind_speed_10m: string;
                };
            };
            // 👆 Type the response so TypeScript knows what fields exist

            // Map WMO weather code to a human-readable description
            // Full list: https://open-meteo.com/en/docs#weathervariables
            const weatherCondition = getWeatherDescription(weatherData.current.weather_code);

            // Build a clean response object for the AI to read
            const weatherResult = {
                city: weatherInputs.city ?? "Unknown location",
                temperature: `${weatherData.current.temperature_2m}${weatherData.current_units.temperature_2m}`,
                // 👆 e.g. "32°C"
                windSpeed: `${weatherData.current.wind_speed_10m} ${weatherData.current_units.wind_speed_10m}`,
                // 👆 e.g. "18.5 km/h"
                condition: weatherCondition,
                // 👆 e.g. "Partly cloudy"
                observedAt: weatherData.current.time,
                // 👆 ISO timestamp of when this reading was taken
            };

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(weatherResult, null, 2),
                    }
                ]
            };
        }
    );


    // ── RESOURCE 1: server-info ──────────────────────────────────────
    // ⭐ MCP Resource — READ-ONLY data the app exposes to the AI client
    //
    // TOOL vs RESOURCE:
    //   Tool     = ACTION  — AI calls it to DO something (fetch weather, create task)
    //   Resource = DATA    — AI reads it for CONTEXT (what tools exist, server config)
    //
    // Resources are READ-ONLY data sources identified by a URI (like a URL for data)
    // The AI application (client) decides WHEN to read resources — not the AI model
    //
    // URI format: <scheme>://<path>
    //   file://    → local files
    //   db://      → database records
    //   mcp://     → custom MCP server data  ← we're using this
    mcpServerInstance.resource(
        "server-info",
        // 👆 Resource name — unique identifier within this server

        "mcp://remote-mcp-server/info",
        // 👆 Resource URI — like a URL but for internal data
        // scheme: "mcp://"
        // host: "remote-mcp-server" (our server name)
        // path: "/info" (what data we're exposing)

        async (uri) => {
            // This function runs when the client does: resources/read
            // uri = the full URI object passed by the client

            // The data we expose as a resource — static server metadata
            const serverInfoData = {
                name: "remote-mcp-server",
                version: "1.0.0",
                transport: "streamable-http",
                port: PORT,
                // 👆 Which port we're running on
                tools: [
                    {
                        name: "get_location",
                        description: "Returns hardcoded Chennai coordinates",
                        requiresInput: false,
                    },
                    {
                        name: "get_weather",
                        description: "Fetches live weather from open-meteo.com",
                        requiresInput: true,
                        inputs: ["latitude", "longitude", "city (optional)"],
                    },
                ],
                // 👆 Describes all available tools — AI can read this for context
                resources: [
                    { uri: "mcp://remote-mcp-server/info", description: "This server info document" },
                    { uri: "mcp://remote-mcp-server/weather-config", description: "Default weather location config" },
                    { uri: "db://taskflow/schema/tasks", description: "TaskFlow DB schema with live stats" },
                ],
                prompts: [
                    { name: "review-tasks", description: "Review pending tasks and suggest priorities" },
                    { name: "weather-report", description: "Get a formatted weather briefing for Chennai" },
                ],
                externalApis: ["https://api.open-meteo.com"],
                // 👆 What external services this server depends on
            };

            return {
                contents: [
                    // 👆 Note: "contents" (plural) — Resources use "contents", Tools use "content"
                    {
                        uri: uri.href,
                        // 👆 Echo back the URI that was requested
                        mimeType: "application/json",
                        // 👆 Tell the client what format this data is in
                        // AI clients use mimeType to decide how to parse/display it
                        text: JSON.stringify(serverInfoData, null, 2),
                        // 👆 The actual data — formatted JSON string
                    }
                ]
            };
        }
    );
    // ── END RESOURCE 1 ───────────────────────────────────────────────


    // ── RESOURCE 2: weather-config ───────────────────────────────────
    // Exposes the default location config this server uses
    //
    // WHY THIS IS USEFUL:
    // Any AI client connecting to our server can READ this resource
    // to know the default city/coordinates BEFORE calling get_weather.
    // Instead of the AI guessing coordinates, it reads them from here.
    mcpServerInstance.resource(
        "weather-config",
        "mcp://remote-mcp-server/weather-config",

        async (uri) => {
            const weatherConfigData = {
                defaultLocation: {
                    city: "Chennai",
                    country: "India",
                    latitude: 13.0827,
                    longitude: 80.2707,
                    timezone: "Asia/Kolkata",
                },
                // 👆 Same values as get_location tool — but exposed as READ-ONLY config
                // AI reads this BEFORE calling get_weather
                // So it knows exactly what coordinates to pass

                weatherApi: {
                    provider: "Open-Meteo",
                    baseUrl: "https://api.open-meteo.com/v1/forecast",
                    requiresApiKey: false,
                    // 👆 Useful for AI to know — no key needed
                    supportedVariables: [
                        "temperature_2m",
                        "wind_speed_10m",
                        "weather_code",
                    ],
                },
                // 👆 Documents what the external API supports
                // AI can use this to understand what data is available

                units: {
                    temperature: "Celsius (°C)",
                    windSpeed: "km/h",
                },
                // 👆 AI knows units upfront — no need to ask or guess
            };

            return {
                contents: [
                    {
                        uri: uri.href,
                        // 👆 Echo back the requested URI
                        mimeType: "application/json",
                        // 👆 JSON config data
                        text: JSON.stringify(weatherConfigData, null, 2),
                    }
                ]
            };
        }
    );
    // ── END RESOURCE 2 ───────────────────────────────────────────────


    // ── RESOURCE 3: tasks-schema (DB based) ──────────────────────────
    // Exposes the TaskFlow database schema + live task counts as a resource
    //
    // WHY THIS IS A CLASSIC RESOURCE USE CASE:
    // When AI needs to query a database, it first needs to KNOW the schema.
    // Instead of the AI guessing column names → it reads this resource first.
    //
    // URI scheme: db:// → signals this is database-related data
    mcpServerInstance.resource(
        "tasks-schema",
        "db://taskflow/schema/tasks",

        async (uri) => {
            // ── Fetch live task stats from TaskFlow API ───────────────
            // This makes it a REAL dynamic resource — not just hardcoded JSON
            // Every time AI reads this resource, it gets fresh counts from DB
            let taskStats = {
                total: 0,
                byStatus: { Todo: 0, InProgress: 0, Done: 0 },
                byPriority: { Low: 0, Medium: 0, High: 0 },
            };

            try {
                // Call our TaskFlow API to get real task counts
                // Must send AUTH_COOKIE — TaskFlow requires authentication
                const apiResponse = await fetch(
                    `http://localhost:3000/api/tasks?page=1&limit=100`,
                    {
                        headers: {
                            "Cookie": process.env.AUTH_COOKIE || "",
                            // 👆 Reads AUTH_COOKIE from .env file
                            // e.g. AUTH_COOKIE=authjs.session-token=<value>
                        }
                    }
                );

                if (apiResponse.ok) {
                    const apiData = await apiResponse.json() as {
                        data: Array<{ status: string; priority: string }>;
                        pagination: { totalTasks: number };
                    };

                    // Count total tasks from pagination info
                    taskStats.total = apiData.pagination?.totalTasks ?? 0;

                    // Loop through tasks and count each status/priority
                    apiData.data?.forEach((task) => {
                        // Count by status
                        if (task.status === "Todo") taskStats.byStatus.Todo++;
                        if (task.status === "InProgress") taskStats.byStatus.InProgress++;
                        if (task.status === "Done") taskStats.byStatus.Done++;

                        // Count by priority
                        if (task.priority === "Low") taskStats.byPriority.Low++;
                        if (task.priority === "Medium") taskStats.byPriority.Medium++;
                        if (task.priority === "High") taskStats.byPriority.High++;
                    });
                }
            } catch (fetchError) {
                // If TaskFlow is not running, we still return the schema
                // just without live stats — graceful degradation
                console.error("Could not fetch live task stats:", fetchError);
            }

            // ── Build the full schema resource ────────────────────────
            const tasksSchemaData = {
                database: "TaskFlow (PostgreSQL via Prisma)",
                // 👆 What DB we're using — AI knows the dialect

                table: "Task",
                // 👆 Prisma model name (maps to "tasks" table in DB)

                columns: [
                    { name: "id", type: "String", prismaType: "String @id @default(cuid())", required: true, description: "Unique identifier — auto-generated CUID", example: "clx1234abc" },
                    { name: "title", type: "String", prismaType: "String", required: true, description: "Task title — what needs to be done", example: "Fix login bug" },
                    { name: "description", type: "String", prismaType: "String?", required: false, description: "Optional detailed description of the task" },
                    { name: "status", type: "Enum", allowedValues: ["Todo", "InProgress", "Done"], required: true, default: "Todo", description: "Current state of the task" },
                    { name: "priority", type: "Enum", allowedValues: ["Low", "Medium", "High"], required: true, default: "Medium", description: "Importance level of the task" },
                    { name: "createdAt", type: "DateTime", prismaType: "DateTime @default(now())", required: true, description: "When the task was created — auto-set by DB" },
                    { name: "updatedAt", type: "DateTime", prismaType: "DateTime @updatedAt", required: true, description: "When the task was last modified — auto-updated by Prisma" },
                ],
                // 👆 Full column definitions — AI uses this to write correct queries

                apiEndpoints: {
                    // 👆 How to interact with this table via our TaskFlow API
                    list: "GET  /api/tasks?page=1&limit=10",
                    create: "POST /api/tasks  { title, description?, priority?, status? }",
                    update: "PUT  /api/tasks/:id  { title?, description?, priority?, status? }",
                    delete: "DELETE /api/tasks/:id",
                },

                mcpTools: {
                    // 👆 MCP tools that map to this schema
                    read: "get_tasks   — paginated list with cursor",
                    create: "create_task — title required, others optional",
                    update: "update_task — id required, rest optional",
                    delete: "delete_task — id required",
                },

                // ── LIVE STATS FROM DB ────────────────────────────────
                // 👆 This is what makes it a real DB resource — live data
                liveStats: taskStats,
                // e.g. { total: 12, byStatus: { Todo: 7, InProgress: 1, Done: 4 } }
                // AI can say "You have 7 pending tasks" without calling get_tasks
            };

            return {
                contents: [
                    {
                        uri: uri.href,
                        // 👆 "db://taskflow/schema/tasks"
                        mimeType: "application/json",
                        text: JSON.stringify(tasksSchemaData, null, 2),
                    }
                ]
            };
        }
    );
    // ── END RESOURCE 3 ───────────────────────────────────────────────


    // ════════════════════════════════════════════════════════════════
    // MCP PROMPTS — The 3rd Primitive
    // ════════════════════════════════════════════════════════════════
    //
    // WHAT ARE PROMPTS?
    // Prompts are reusable message TEMPLATES that the USER picks.
    // Think of them like slash commands — /review-tasks, /weather-report
    //
    // 3 PRIMITIVES COMPARISON:
    //   Tools     → controlled by AI model  → DO actions (side effects OK)
    //   Resources → controlled by App       → READ data (read-only)
    //   Prompts   → controlled by USER      → TEMPLATE messages (user picks)
    //
    // HOW PROMPTS WORK:
    //   1. User sees list of available prompts in the client UI
    //   2. User picks one and fills in the arguments
    //   3. Client calls prompts/get → server returns a filled message
    //   4. Client sends that message to the AI model
    //   5. AI responds based on the template
    //
    // ⭐ KEY SYNTAX FOR SDK 1.32 — prompt() takes 3 arguments ONLY:
    //   mcpServerInstance.prompt(
    //       "name",                          // arg 1: prompt name
    //       { argName: z.string() },         // arg 2: zod schema for arguments
    //       ({ argName }) => ({ messages })  // arg 3: callback — destructure args directly
    //   )
    //   → NO description string parameter (unlike tools which have 4 args)
    //   → callback receives parsed args via destructuring — NOT (promptArgs) =>
    //   → returns { messages: [...] } — NOT content, NOT contents
    //
    // KEY RETURN SHAPE DIFFERENCE (VERY IMPORTANT):
    //   Tools     → return { content: [...] }    ← singular
    //   Resources → return { contents: [...] }   ← plural
    //   Prompts   → return { messages: [...] }   ← array of chat messages
    // ════════════════════════════════════════════════════════════════


    // ── PROMPT 1: review-tasks ───────────────────────────────────────
    // Template for asking AI to review and prioritize tasks
    //
    // REAL-WORLD PARALLEL:
    // Like a standup template — every morning you run this prompt
    // to get an AI review of what to work on today
    //
    // USER FLOW IN MCP INSPECTOR:
    //   Prompts tab → select "review-tasks"
    //   → fill in optional "focus" field (e.g. "High priority")
    //   → click Get Prompt
    //   → see the pre-built message ready to send to AI
    mcpServerInstance.prompt(
        "review-tasks",
        // 👆 Prompt name — appears in the client's Prompts tab

        // ⚠️ NOTE: SDK 1.32 prompt() does NOT have a description parameter
        // Description is auto-inferred from the prompt name by the client

        {
            // ── Optional argument: what to focus on ───────────────────
            focus: z.string()
                .optional()
                .describe("What to focus on — e.g. 'urgent items', 'High priority', 'overdue'"),
            // 👆 User can leave this blank — prompt works without it
        },

        ({ focus }) => {
            // 👆 SDK 1.32 syntax: destructure args directly in the callback
            // NOT: async (promptArgs) => { promptArgs.focus }
            // YES: ({ focus }) => { focus }
            // No async needed — we're just building a string template

            // Build the focus line — only include if user provided it
            const focusLine = focus
                ? `\nFocus especially on: ${focus}`
                : "";
            // 👆 Conditional text — clean output whether focus is given or not

            // ── Return the filled prompt as a messages array ──────────
            // "messages" is the key difference from Tools (content) and Resources (contents)
            // It follows the same shape as a chat conversation:
            //   role: "user" | "assistant"
            //   content: { type: "text", text: "..." }
            return {
                messages: [
                    {
                        role: "user" as const,
                        // 👆 "as const" tells TypeScript: this is literal type "user", not just string
                        // Required because the SDK expects exact literal types, not generic string
                        content: {
                            type: "text" as const,
                            // 👆 Same reason — "text" as literal type, not generic string
                            text: `You are a productivity assistant helping me manage my TaskFlow tasks.

Please review my current tasks and help me prioritize what to work on next.${focusLine}

For each task you identify as important, please:
1. State the task title and current status
2. Explain why it should be prioritized
3. Suggest a concrete next action

End with a short summary of the recommended order to tackle tasks today.

Note: You can use the get_tasks tool to fetch the actual task list, and the tasks-schema resource for DB context.`,
                        }
                    }
                ]
            };
        }
    );
    // ── END PROMPT 1 ─────────────────────────────────────────────────


    // ── PROMPT 2: weather-report ─────────────────────────────────────
    // Template for getting a formatted weather briefing
    //
    // REAL-WORLD PARALLEL:
    // Like a morning briefing template — user picks this every day
    // to get a consistent, well-formatted weather summary
    //
    // WHY THIS IS BETTER THAN JUST CALLING get_weather DIRECTLY:
    // The prompt tells the AI HOW to present the data:
    //   - What format to use (emoji sections, bold headers)
    //   - What recommendations to include (clothing, activity)
    //   - What tone to use (concise, practical)
    // Without a prompt → AI decides output format on its own → inconsistent
    // With a prompt    → same format every time the user runs it → predictable
    mcpServerInstance.prompt(
        "weather-report",
        // 👆 Prompt name

        {
            // ── Optional argument: activity context ───────────────────
            activity: z.string()
                .optional()
                .describe("What you're planning — e.g. 'commute', 'outdoor meeting', 'evening walk'"),
            // 👆 Personalizes the recommendations based on what user is doing
        },

        ({ activity }) => {
            // 👆 SDK 1.32 syntax: destructure activity directly
            // No async needed — just building a template string

            // Build activity context line if user provided it
            const activityContext = activity
                ? `\nI'm planning to: ${activity}`
                : "";
            // 👆 Makes recommendations relevant to the user's specific situation

            return {
                messages: [
                    {
                        role: "user" as const,
                        // 👆 Prompt message sent as the user to the AI
                        content: {
                            type: "text" as const,
                            text: `Give me a morning weather briefing for Chennai, India.${activityContext}

Please use the get_weather tool with Chennai coordinates (lat: 13.0827, lon: 80.2707).

Format your response as:
🌤️ **Chennai Weather — [current time]**
- Temperature: [temp]
- Condition: [condition]
- Wind: [wind speed]

💡 **What to wear:**
[clothing recommendation based on temperature and condition]

🗓️ **Activity advice:**
[advice based on the weather and my planned activity]

Keep it concise and practical.`,
                        }
                    }
                ]
            };
        }
    );
    // ── END PROMPT 2 ─────────────────────────────────────────────────


    return mcpServerInstance;
    // 👆 Return the fully configured server instance ready to connect
}


// ── HELPER: WMO weather code → description ────────────────────────
// WMO = World Meteorological Organization
// Open-Meteo uses their standard codes
function getWeatherDescription(weatherCode: number): string {
    // Map the most common WMO codes to readable descriptions
    const weatherCodeDescriptions: Record<number, string> = {
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Foggy",
        48: "Icy fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        71: "Slight snow",
        73: "Moderate snow",
        75: "Heavy snow",
        80: "Slight showers",
        81: "Moderate showers",
        82: "Violent showers",
        95: "Thunderstorm",
        99: "Thunderstorm with hail",
    };

    return weatherCodeDescriptions[weatherCode] ?? `Weather code ${weatherCode}`;
    // 👆 If code not in our map, fall back to showing the raw code
}


// ── STEP 3: The single MCP endpoint ──────────────────────────────
// ⭐ KEY CHANGE: We create a FRESH server + transport per request
//
// WHY: StreamableHTTPServerTransport in stateless mode (sessionIdGenerator: undefined)
// is designed to handle exactly ONE request lifecycle (initialize → tools/call → done).
// Reusing the same transport instance causes it to be in "already connected" state
// when the next initialize arrives — that's what caused HTTP 500.
//
// Each POST to /mcp gets:
//   1. A brand-new McpServer with all tools + resources + prompts registered
//   2. A brand-new StreamableHTTPServerTransport
//   3. They connect, handle the single request, then get garbage collected
//
// This is the correct pattern for stateless MCP servers.
app.post("/mcp", async (request, response) => {
    // Create a fresh server instance for this request
    const perRequestServer = buildMcpServer();

    // Create a fresh transport for this request
    const perRequestTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // 👆 stateless — no session ID, each request is fully independent
    });

    // Clean up both when the response closes (success or error)
    response.on("close", () => {
        perRequestTransport.close();
        perRequestServer.close();
        // 👆 Prevent memory leaks — release handlers and event listeners
    });

    try {
        // Connect the fresh server to the fresh transport
        await perRequestServer.connect(perRequestTransport);

        // Hand the request to the transport — it handles the full MCP protocol:
        // parse JSON-RPC → route to tool/resource/prompt → format response → send back
        await perRequestTransport.handleRequest(request, response, request.body);

    } catch (serverError) {
        console.error("MCP request error:", serverError);

        // Only send error response if headers haven't been sent yet
        if (!response.headersSent) {
            response.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                },
                id: null,
            });
        }
    }
});


// ── STEP 4: Start listening ───────────────────────────────────────
// No mcpServer.connect() here anymore — that happens per-request above
app.listen(PORT, () => {
    console.log(`✅ Remote MCP Server running at http://localhost:${PORT}/mcp`);
    console.log(`📍 Tools     : get_location, get_weather`);
    console.log(`📚 Resources : mcp://remote-mcp-server/info, mcp://remote-mcp-server/weather-config, db://taskflow/schema/tasks`);
    console.log(`💬 Prompts   : review-tasks, weather-report`);
    // 👆 All 3 MCP primitives now registered
});
