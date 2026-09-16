def sanitize_preference(payload):
    key, value = payload.get("key"), payload.get("value")
    if key in {"dark_theme", "deepThink"} and isinstance(value, bool):
        return {"key": key, "value": value}
    if key == "modelTemp" and isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 100:
        return {"key": key, "value": value}
    if key in {"modelName", "modelProvider"} and isinstance(value, str) and len(value) <= 200:
        return {"key": key, "value": value}
    if key in {"activeProvider", "rolePrompt"} and isinstance(value, dict):
        fields = ("provider_id", "name") if key == "activeProvider" else ("name", "definition")
        return {"key": key, "value": {field: str(value.get(field) or "")[:16000] for field in fields}}
    return None
