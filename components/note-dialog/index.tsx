"use client";
import React from "react";
import useNoteId from "@/hooks/use-note-id";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import NoteView from "./note-view";

const NoteDialog = () => {
    const { noteId, clearNoteId } = useNoteId();

    const isOpen = Boolean(noteId);

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            clearNoteId();
        }
    };

    return (
        <Sheet open={isOpen} onOpenChange={handleOpenChange}>
            <SheetContent
                side="right"
                className="p-0 border-l lg:w-1/2 sm:max-w-[50vw]"
            >
                <SheetHeader className="py-2 border-b bg-muted px-4">
                    <SheetTitle>Note</SheetTitle>
                </SheetHeader>
                <div className="flex-1 min-h-20 max-h-screen overflow-y-auto">
                    {/* {noteId && <NoteView noteId={noteId} />} */}
                </div>
            </SheetContent>
        </Sheet>
    );
};

export default NoteDialog;
