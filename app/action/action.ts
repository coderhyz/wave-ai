"use server"
import { myProvider } from "@/lib/ai/provider"
import { TITLE_GENERATION_SETTINGS } from "@/lib/ai/generation-settings"
import { generateText, type UIMessage } from "ai"
// 根据用户的消息生成标题
export async function generateTitleForUserMessage({
  message,
}: {
  message: UIMessage
}) {
  try {
    const { text } = await generateText({
      model: myProvider.languageModel("title-model"),
      ...TITLE_GENERATION_SETTINGS,
      instructions: `\n
                - you will generate a short title based on the first message a user begins a conversation with
                - ensure it is not more than 80 characters long
                - the title should be a summary of the user's message
                - do not use quotes or colons`,
      prompt: JSON.stringify(message),
    })
    return text
  } catch (error) {
    console.log("Title ai error", error)
    return "Untitled"
  }
}
