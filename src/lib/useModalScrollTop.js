import { useEffect } from "react";

let activeModalCount = 0;
let originalDocumentOverflow = "";
let originalBodyOverflow = "";

export default function useModalScrollTop(
  isOpen = true,
  scrollToTop = true
) {
  useEffect(() => {
    if (!isOpen) return undefined;

    if (scrollToTop) {
      window.scrollTo(0, 0);
    }

    if (activeModalCount === 0) {
      originalDocumentOverflow =
        document.documentElement.style.overflow;
      originalBodyOverflow = document.body.style.overflow;
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
    }

    activeModalCount += 1;

    return () => {
      activeModalCount -= 1;

      if (activeModalCount === 0) {
        document.documentElement.style.overflow =
          originalDocumentOverflow;
        document.body.style.overflow = originalBodyOverflow;
      }
    };
  }, [isOpen, scrollToTop]);
}
