import { extension } from "../lib/store";

export function iconForFile(path: string): { icon: string; color: string } {
  switch (extension(path)) {
    case "tex":
    case "ltx":
      return { icon: "description", color: "#4f9de8" };
    case "bib":
      return { icon: "menu_book", color: "#d9a43a" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
    case "eps":
      return { icon: "image", color: "#3fae6a" };
    case "pdf":
      return { icon: "picture_as_pdf", color: "#e06c5f" };
    case "sty":
    case "cls":
    case "bst":
      return { icon: "tune", color: "#a07ad6" };
    case "md":
    case "txt":
      return { icon: "notes", color: "#9aa3b2" };
    default:
      return { icon: "draft", color: "#9aa3b2" };
  }
}
