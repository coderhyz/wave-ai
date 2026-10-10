import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
/**
 * 合并 CSS 类名
 * @param inputs 合并
 * @returns 
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
