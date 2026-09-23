import { parseAsString, useQueryState } from "nuqs";
// nodeId搜索参数
const useNoteId = () => {
    const [noteId, _setNoteId] = useQueryState(
        "noteId",
        parseAsString.withDefault("")
    );
    // 设置Id
    const setNoteId = (id: string) => _setNoteId(id);
    // 清除Id
    const clearNoteId = () => _setNoteId(null);

    return {
        noteId,
        setNoteId,
        clearNoteId,
    };
};

export default useNoteId;