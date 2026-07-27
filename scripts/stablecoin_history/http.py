from __future__ import annotations

import random
import time
from typing import Any

import requests


class SourceError(RuntimeError):
    """A remote source did not return a trustworthy response."""


class RetryingSession:
    def __init__(
        self,
        *,
        timeout: float = 30.0,
        max_attempts: int = 5,
        min_interval: float = 0.0,
    ) -> None:
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.min_interval = min_interval
        self._last_request_at = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "stablecoin-dashboard/5"})

    def _throttle(self) -> None:
        remaining = self.min_interval - (time.monotonic() - self._last_request_at)
        if remaining > 0:
            time.sleep(remaining)

    def get_json(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        delay = 1.0
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            self._throttle()
            try:
                response = self.session.get(
                    url, params=params, headers=headers, timeout=self.timeout
                )
                self._last_request_at = time.monotonic()
                if response.status_code == 429 or response.status_code >= 500:
                    raise SourceError(f"HTTP {response.status_code}")
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise SourceError("Réponse JSON inattendue")
                return payload
            except (requests.RequestException, ValueError, SourceError) as exc:
                last_error = exc
                if attempt == self.max_attempts:
                    break
                retry_after = 0.0
                if isinstance(exc, requests.HTTPError) and exc.response is not None:
                    try:
                        retry_after = float(exc.response.headers.get("Retry-After", "0"))
                    except ValueError:
                        retry_after = 0.0
                sleep_for = max(retry_after, delay) + random.uniform(0, 0.25)
                time.sleep(sleep_for)
                delay = min(delay * 2, 20.0)
        raise SourceError(f"Source indisponible après {self.max_attempts} essais: {last_error}")
