// 天气查询

import { tool } from "ai"
import { z } from "zod"

const geoResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        country: z.string(),
        admin1: z.string().optional(),
        latitude: z.number(),
        longitude: z.number(),
      })
    )
    .optional(),
})
const weatherResponseSchema = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    apparent_temperature: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number()),
  }),
})

function describeWeather(code: number): string {
  if (code === 0) return "晴"
  if (code <= 3) return "多云"
  if ([45, 48].includes(code)) return "雾"
  if (code >= 51 && code <= 57) return "毛毛雨"
  if (code >= 61 && code <= 67) return "雨"
  if (code >= 71 && code <= 77) return "雪"
  if (code >= 80 && code <= 82) return "阵雨"
  if (code >= 85 && code <= 86) return "阵雪"
  if (code >= 95) return "雷暴"
  return "未知"
}

async function fetchJson<T>(
  url: URL,
  schema: z.ZodType<T>,
  abortSignal?: AbortSignal
): Promise<T> {
  abortSignal?.throwIfAborted()
  const response = await fetch(url, {
    signal: AbortSignal.any([
      AbortSignal.timeout(10000),
      ...(abortSignal ? [abortSignal] : []),
    ]),
  })

  if (!response.ok) {
    throw new Error(`天气 API 请求失败: ${response.status}`)
  }

  return schema.parse(await response.json())
}

export const getWeather = tool({
  description:
    "查询指定城市的当前天气和未来天气预报。适用于气温、降雨、风速、出行天气等问题。",

  inputSchema: z.object({
    city: z
      .string()
      .min(2)
      .describe("需要查询的城市名称，例如：成都、北京、新加坡"),
    days: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .describe("需要查询的预报天数，默认3天，最多7天"),
  }),

  execute: async ({ city, days = 3 }, { abortSignal }) => {
    abortSignal?.throwIfAborted()
    try {
      // 1. 城市名称转换为经纬度
      const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search")

      geoUrl.searchParams.set("name", city)
      geoUrl.searchParams.set("count", "1")
      geoUrl.searchParams.set("language", "zh")

      const geo = await fetchJson(geoUrl, geoResponseSchema, abortSignal)
      const location = geo.results?.[0]

      if (!location) {
        return {
          success: false,
          error: `未找到城市：${city}`,
        }
      }

      // 2. 根据经纬度查询天气
      const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast")

      weatherUrl.searchParams.set("latitude", String(location.latitude))
      weatherUrl.searchParams.set("longitude", String(location.longitude))

      weatherUrl.searchParams.set(
        "current",
        [
          "temperature_2m",
          "relative_humidity_2m",
          "apparent_temperature",
          "weather_code",
          "wind_speed_10m",
        ].join(",")
      )

      weatherUrl.searchParams.set(
        "daily",
        [
          "weather_code",
          "temperature_2m_max",
          "temperature_2m_min",
          "precipitation_probability_max",
        ].join(",")
      )

      weatherUrl.searchParams.set("timezone", "auto")
      weatherUrl.searchParams.set("forecast_days", String(days))

      const data = await fetchJson(
        weatherUrl,
        weatherResponseSchema,
        abortSignal
      )

      // 3. 统一返回数据结构
      return {
        success: true,
        location: {
          city: location.name,
          region: location.admin1 ?? null,
          country: location.country,
        },
        timezone: data.timezone,
        current: {
          time: data.current.time,
          temperature: data.current.temperature_2m,
          feelsLike: data.current.apparent_temperature,
          humidity: data.current.relative_humidity_2m,
          windSpeed: data.current.wind_speed_10m,
          description: describeWeather(data.current.weather_code),
        },
        forecast: data.daily.time.map((date, i) => ({
          date,
          description: describeWeather(data.daily.weather_code[i]),
          maxTemp: data.daily.temperature_2m_max[i],
          minTemp: data.daily.temperature_2m_min[i],
          rainProbability: data.daily.precipitation_probability_max[i],
        })),
        units: {
          temperature: "°C",
          humidity: "%",
          windSpeed: "km/h",
          rainProbability: "%",
        },
        source: "Open-Meteo",
      }
    } catch (error) {
      abortSignal?.throwIfAborted()
      return {
        success: false,
        error: error instanceof Error ? error.message : "天气查询失败",
      }
    }
  },
})
