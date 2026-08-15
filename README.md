This app allows you to act as a model in a v1/chat/completions API. You will see exactly what the model sees, and you will be able to send messages and call tools as the model.

Unlike my other projects, this one is vibecoded.

### How to use

```bash
git clone https://github.com/inikishev/humanai
cd humanai
uv run main.py
```

Then open <http://127.0.0.1:5000> in your browser for the UI.

The Chat Completions endpoint is at <http://localhost:5000/v1/chat/completions>.

To add yourself as a model in opencode, use this config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local-endpoint": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "humanai",
      "options": {
        "baseURL": "http://localhost:5000/v1"
      },
      "models": {
        "me": {
          "name": "Myself",
          "tools": true
        }
      }
    }
  }
}
```

plop it into any folder and open opencode in it, and select "Myself" as the model. Send any message in opencode, and you will be able to reply to it in the web UI.

<img width="2101" height="1366" alt="image" src="https://github.com/user-attachments/assets/fbef973a-780d-4b5e-be95-5612d905524e" />

### What you can do with this

- Inspect everything a model sees when using a harness - system message, tool schemas. For example here is [opencode (gist.github.com)](https://gist.githubusercontent.com/inikishev/2f9db04df649017405d931016b5aa48b/raw/399a0e1ec182e49bb119b4c83930937cc37e66c3/Opencode-system-message.json);
- Debug your CLIs, tools, etc;
- Context engineering by sending custom messages from assistant, and then switching to a different model;
- Try working on a project as a model, yes this is the pain that models have to go through.
