import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getWeather } from "@/lib/ai/tool/weather"
import { webSearch } from "@/lib/ai/tool/web-search"

const fetchMock = vi.fn<typeof fetch>()
const location = {
  name: "北京",
  country: "中国",
  admin1: "北京",
  latitude: 39.9,
  longitude: 116.4,
}
const weather = {
  timezone: "Asia/Shanghai",
  current: {
    time: "2026-10-13T20:00",
    temperature_2m: 19,
    relative_humidity_2m: 50,
    apparent_temperature: 18,
    weather_code: 0,
    wind_speed_10m: 8,
  },
  daily: {
    time: ["2026-10-13"],
    weather_code: [3],
    temperature_2m_max: [23],
    temperature_2m_min: [12],
    precipitation_probability_max: [10],
  },
}
const options = (abortSignal?: AbortSignal) => ({
  toolCallId: "test-call",
  context: {},
  messages: [],
  abortSignal,
})
const runWeb = (abortSignal?: AbortSignal) => {
  if (!webSearch.execute) throw new Error("Missing search executor")
  return webSearch.execute({ query: "官方 API 文档" }, options(abortSignal))
}
const runWeather = (abortSignal?: AbortSignal) => {
  if (!getWeather.execute) throw new Error("Missing weather executor")
  return getWeather.execute({ city: "北京", days: 1 }, options(abortSignal))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("TAVILY_API_KEY", "test-key")
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("external chat tools", () => {
  it("queries Tavily with authentication and preserves source links and publication dates", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          {
            title: "文档",
            url: "https://example.test/docs",
            content: "文档摘要",
            score: 0.9,
            published_date: "2026-10-13",
          },
        ],
      })
    )
    expect(await runWeb()).toMatchObject({
      success: true,
      source: "Tavily",
      results: [
        {
          title: "文档",
          url: "https://example.test/docs",
          snippet: "文档摘要",
          publishedAt: "2026-10-13",
        },
      ],
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.tavily.com/search")
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-key"
    )
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "官方 API 文档",
      max_results: 5,
      include_published_date: true,
      include_answer: false,
    })
  })
  it("distinguishes valid empty search results from a malformed API response", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({}))
    expect(await runWeb()).toMatchObject({ success: true, results: [] })
    expect(await runWeb()).toMatchObject({
      success: false,
      error: expect.any(String),
    })
  })
  it("does not query Tavily without a configured key", async () => {
    vi.stubEnv("TAVILY_API_KEY", undefined)
    expect(await runWeb()).toEqual({
      success: false,
      error: "服务端未配置 TAVILY_API_KEY",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("queries the resolved city's weather and returns local time, forecast and units", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ results: [location] }))
      .mockResolvedValueOnce(Response.json(weather))
    expect(await runWeather()).toMatchObject({
      success: true,
      source: "Open-Meteo",
      location: { city: "北京" },
      timezone: "Asia/Shanghai",
      current: { time: "2026-10-13T20:00", temperature: 19, description: "晴" },
      forecast: [
        { date: "2026-10-13", description: "多云", maxTemp: 23, minTemp: 12 },
      ],
      units: { temperature: "°C", windSpeed: "km/h" },
    })
    const geo = new URL(String(fetchMock.mock.calls[0][0]))
    expect(geo.hostname).toBe("geocoding-api.open-meteo.com")
    expect(geo.searchParams.get("name")).toBe("北京")
    const forecast = new URL(String(fetchMock.mock.calls[1][0]))
    expect(forecast.searchParams.get("latitude")).toBe("39.9")
    expect(forecast.searchParams.get("longitude")).toBe("116.4")
    expect(forecast.searchParams.get("forecast_days")).toBe("1")
    expect(forecast.searchParams.get("timezone")).toBe("auto")
  })
  it("does not request a forecast when the city is not found", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))
    expect(await runWeather()).toEqual({
      success: false,
      error: "未找到城市：北京",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it("does not report success for malformed weather data", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ results: [location] }))
      .mockResolvedValueOnce(
        Response.json({ timezone: "Asia/Shanghai", current: {}, daily: {} })
      )
    expect(await runWeather()).toMatchObject({
      success: false,
      error: expect.any(String),
    })
  })
  it.each([runWeb, runWeather])(
    "exposes HTTP failure without an additional retry",
    async (run) => {
      fetchMock.mockResolvedValueOnce(
        new Response("unavailable", { status: 429 })
      )
      expect(await run()).toMatchObject({
        success: false,
        error: expect.stringContaining("429"),
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  )
  it.each([runWeb, runWeather])(
    "does not start an already cancelled tool",
    async (run) => {
      const controller = new AbortController()
      const error = new Error("cancelled")
      controller.abort(error)
      await expect(run(controller.signal)).rejects.toBe(error)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
  it.each([runWeb, runWeather])(
    "cancels its in-flight request when generation stops",
    async (run) => {
      const controller = new AbortController()
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true }
            )
          })
      )
      const pending = run(controller.signal)
      const error = new Error("stopped")
      const assertion = expect(pending).rejects.toBe(error)
      controller.abort(error)
      await assertion
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    }
  )
})
