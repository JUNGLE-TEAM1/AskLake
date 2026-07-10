import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.core.config import Settings


class TextStructuringProviderError(RuntimeError):
    pass


class OpenAICompatibleTextProvider:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def available(self) -> bool:
        return bool(self.api_key and self.settings.text_structuring_enabled)

    @property
    def api_key(self) -> str | None:
        return self.settings.text_structuring_api_key or self.settings.openai_api_key

    def infer(
        self,
        *,
        instructions: str,
        rows: list[dict[str, Any]],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]:
        return self.generate_json(
            name="text_structuring_batch",
            instructions=instructions,
            input_payload={"rows": rows},
            response_schema=response_schema,
        )

    def generate_json(
        self,
        *,
        name: str,
        instructions: str,
        input_payload: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.available:
            raise TextStructuringProviderError("Text structuring provider is not configured.")

        endpoint = self.settings.text_structuring_api_url.rstrip("/")
        if endpoint.endswith("/chat/completions"):
            payload = self._chat_completions_payload(
                name=name,
                instructions=instructions,
                input_payload=input_payload,
                response_schema=response_schema,
            )
        else:
            if not endpoint.endswith("/responses"):
                endpoint = f"{endpoint}/responses"
            payload = self._responses_payload(
                name=name,
                instructions=instructions,
                input_payload=input_payload,
                response_schema=response_schema,
            )

        request = Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.settings.text_structuring_timeout_seconds) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise TextStructuringProviderError(f"Provider returned HTTP {exc.code}.") from exc
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise TextStructuringProviderError(f"Provider request failed: {exc.__class__.__name__}.") from exc

        output_text = extract_output_text(response_payload)
        if not output_text:
            raise TextStructuringProviderError("Provider response did not contain JSON text.")
        try:
            parsed = json.loads(output_text)
        except json.JSONDecodeError as exc:
            raise TextStructuringProviderError("Provider response was not valid JSON.") from exc
        if not isinstance(parsed, dict):
            raise TextStructuringProviderError("Provider response JSON root must be an object.")
        return parsed

    def _responses_payload(
        self,
        *,
        name: str,
        instructions: str,
        input_payload: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "model": self.settings.text_structuring_model,
            "instructions": instructions,
            "input": json.dumps(input_payload, ensure_ascii=False),
            "max_output_tokens": self.settings.text_structuring_max_output_tokens,
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": name,
                    "strict": True,
                    "schema": response_schema,
                }
            },
        }

    def _chat_completions_payload(
        self,
        *,
        name: str,
        instructions: str,
        input_payload: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "model": self.settings.text_structuring_model,
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": json.dumps(input_payload, ensure_ascii=False)},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": name,
                    "strict": True,
                    "schema": response_schema,
                },
            },
            "max_tokens": self.settings.text_structuring_max_output_tokens,
            "temperature": 0,
        }


def extract_output_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str):
        return output_text

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            return content

    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    chunks: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)
