import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import {
  appViewHistoryChangedEvent,
  readAppViewHistoryAvailability
} from "../hooks/useAppViewHistory";

type HistoryNavigationButtonsProps = {
  t: ReturnType<typeof createTranslator>;
};

export function HistoryNavigationButtons({ t }: HistoryNavigationButtonsProps) {
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    const updateAvailability = () => {
      const availability = readAppViewHistoryAvailability();
      setCanGoBack(availability.canGoBack);
      setCanGoForward(availability.canGoForward);
    };

    updateAvailability();
    window.addEventListener("popstate", updateAvailability);
    window.addEventListener(appViewHistoryChangedEvent, updateAvailability);
    return () => {
      window.removeEventListener("popstate", updateAvailability);
      window.removeEventListener(appViewHistoryChangedEvent, updateAvailability);
    };
  }, []);

  const goBack = useCallback(() => {
    if (!canGoBack) {
      return;
    }
    window.history.back();
  }, [canGoBack]);

  const goForward = useCallback(() => {
    if (!canGoForward) {
      return;
    }
    window.history.forward();
  }, [canGoForward]);

  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("navigateBack")}
        disabled={!canGoBack}
        onClick={goBack}
      >
        <ArrowLeftIcon data-icon="inline-start" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("navigateForward")}
        disabled={!canGoForward}
        onClick={goForward}
      >
        <ArrowRightIcon data-icon="inline-start" />
      </Button>
    </>
  );
}
