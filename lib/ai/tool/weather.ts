
import { tool } from "ai";
import { z } from "zod";

// Open-Meteo 返回的数据类型
type Location = {
  name: string;
  country: string;
  admin1?: string;
  latitude: number;
  longitude: number;
};

type Weather = {
  timezone: string;
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
};

/** 将 WMO 天气代码转换为中文描述 */
function describeWeather(code: number): string {
  if (code === 0) return "晴";
  if (code <= 3) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if (code <= 57) return "毛毛雨";
  if (code <= 67) return "雨";
  if (code <= 77) return "雪";
  if (code <= 82) return "阵雨";
  if (code <= 86) return "阵雪";
  if (code >= 95) return "雷暴";
  return "未知";
}

/** 统一发送 GET 请求，10 秒超时 */
async function fetchJson<T>(url: URL, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);

  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    throw new Error(`天气 API 请求失败：${response.status}`);
  }

  return (await response.json()) as T;
}

/**  天气查询工具 */
export const getWeather = tool({
  description: "查询指定城市的实时天气和未来天气预报，包括温度、降雨、湿度和风速。",

  inputSchema: z.object({
    city: z.string().trim().min(2).describe("城市名称，如成都、北京"),
    days: z.number().int().min(1).max(7).default(3)
      .describe("预报天数，默认3天"),
  }),

  execute: async ({ city, days }, { abortSignal }) => {
    try {
      // 1. 根据城市名称获取经纬度
      const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");

      geoUrl.search = new URLSearchParams({
        name: city,
        count: "1",
        language: "zh",
      }).toString();

      const geo = await fetchJson<{ results?: Location[] }>(
        geoUrl, abortSignal
      );

      const location = geo.results?.[0];
      if (!location) {
        return { success: false, error: `未找到城市：${city}` };
      }

      // 2. 根据经纬度查询实时天气和未来预报
      const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");

      weatherUrl.search = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        current: [
          "temperature_2m",
          "apparent_temperature",
          "relative_humidity_2m",
          "wind_speed_10m",
          "weather_code",
        ].join(","),
        daily: [
          "weather_code",
          "temperature_2m_max",
          "temperature_2m_min",
          "precipitation_probability_max",
        ].join(","),
        timezone: "auto",
        forecast_days: String(days),
      }).toString();

      const data = await fetchJson<Weather>(weatherUrl, abortSignal);

      // 3. 整理数据，返回给 Agent
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
      };
    } catch (error) {
      // 主动取消请求时，让取消信号继续向上传递
      abortSignal?.throwIfAborted();

      return {
        success: false,
        error: error instanceof Error ? error.message : "天气查询失败",
      };
    }
  },
});
