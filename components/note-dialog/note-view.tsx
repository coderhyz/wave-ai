
type NoteViewProps = {
    noteId: string;
};

function NoteView({ noteId }: NoteViewProps) {
    return (
        <div className="p-4">
            NoteView content: {noteId}
        </div>
    );
}

export default NoteView;
