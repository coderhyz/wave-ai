import Header from "@/app/(routes)/(dashboard)/_common/header"
import { KnowledgeWorkspace } from "@/components/knowledge/knowledge-workspace"
function MainSection() {
  return (
    <div className="h-dvh w-full overflow-hidden pt-13">
      <Header title="知识库" />
      {/* 保留现有 /home 入口，目录和正文各自在面板内滚动。 */}
      <div className="h-full min-h-0">
        <KnowledgeWorkspace />
      </div>
    </div>
  )
}

export default MainSection
