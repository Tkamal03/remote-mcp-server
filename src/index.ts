import "dotenv/config";
// 👆 Loads .env file — we'll use this for PORT later

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


// ── STEP 2: Tool registration factory ────────────────────────────
// In stateless mode, we create a fresh McpServer + transport per request.
// This function registers all our tools onto any given server instance.
// We keep the tool logic in ONE place so it doesn't get duplicated.
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
//   1. A brand-new McpServer with all tools registered
//   2. A brand-new StreamableHTTPServerTransport
//   3. They connect, handle the single request, then get garbage collected
//
// This is the correct pattern for stateless MCP servers.
// Source: https://dev.to/parkerrrrr/the-parts-of-building-an-mcp-server-that-the-tutorials-skip-3n07
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
        // parse JSON-RPC → route to tool → format response → send back
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
    console.log(`📍 Tools available: get_location, get_weather`);
});
