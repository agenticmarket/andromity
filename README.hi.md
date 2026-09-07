<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — VS Code और टर्मिनल के लिए AI कोडिंग एजेंट

  **विश्वास-शासित, BYOK, सब-एजेंट्स, लाइव प्लान, नेटिव डिफ्स और एक-क्लिक रोलबैक के साथ स्वायत्त कोडिंग एजेंट।**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | हिन्दी

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** एक निजी, BYOK (अपनी स्वयं की API कुंजी) स्वायत्त AI कोडिंग एजेंट है। इसे VS Code में आधिकारिक एक्सटेंशन के साथ उपयोग करें, या एक स्टैंडअलोन टर्मिनल वर्कस्पेस के रूप में चलाएं। यह जटिल कार्यों की योजना बनाता है, समानांतर सब-एजेंट्स का प्रबंधन करता है, लाइव चरण-दर-चरण ब्लूप्रिंट दिखाता है, कोड लागू करने से पहले डिफ्स की समीक्षा करने देता है, और तत्काल एक-क्लिक रोलबैक प्रदान करता है।

अपने पसंदीदा AI मॉडल (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) को कनेक्ट करें या **Ollama के साथ 100% स्थानीय और मुफ़्त** चलाएं।

---

## ⚡ त्वरित इंस्टॉलेशन और शुरुआत

### 🚀 विकल्प A: VS Code एक्सटेंशन (अनुशंसित)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code में इंस्टॉल करें" />
  </a>
</div>

👉 **अनुशंसित:** सीधे मार्केटप्लेस से एक्सटेंशन इंस्टॉल करें:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

या टर्मिनल से तुरंत इंस्टॉल करें:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 विकल्प B: टर्मिनल CLI

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# या pipx के माध्यम से
pipx install andromity
```

---

## ✨ मुख्य विशेषताएं

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="लाइव टास्क प्लानर और ब्लूप्रिंट" width="100%" />
</div>

### 📝 लाइव टास्क प्लानर और ब्लूप्रिंट
Andromity आपके कोडबेस का विश्लेषण करता है, एक इंटरैक्टिव चरण-दर-चरण योजना बनाता है, और कोई भी कोड लिखने से पहले आपकी मंज़ूरी की प्रतीक्षा करता है। किसी भी चरण की समीक्षा करें, स्वीकृत करें या छोड़ें।

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp" alt="स्थानीय मुफ्त Ollama सहित 396+ मॉडल समर्थन" width="100%" />
</div>

### 🤖 396+ मॉडल समर्थन — स्थानीय मुफ़्त Ollama सहित
Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq को कनेक्ट करें या Ollama के साथ 100% ऑफ़लाइन चलाएं। सत्र के बीच में `Ctrl+L` के साथ मॉडल बदलें।

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="विश्वास और वर्कस्पेस गवर्नेंस" width="100%" />
</div>

### 🔐 विश्वास गवर्नेंस — आप हमेशा नियंत्रण में हैं

| मोड | योजनाएं | फाइल राइट्स | टर्मिनल कमांड्स |
|------|-------|-------------|-------------------|
| **SAFE** *(डिफ़ॉल्ट)* | प्रत्येक को स्वीकृत करें | प्रत्येक को स्वीकृत करें | प्रत्येक को स्वीकृत करें |
| **TRUST** | स्वीकृत | सीधे लागू | सीधे लागू |
| **FULL** | स्वचालित | सीधे लागू | सीधे लागू |
| **YOLO** | स्वचालित | शांत (साइलेंट) | शांत (साइलेंट) |

जब तक आप किसी फ़ोल्डर को विश्वसनीय घोषित नहीं करते, एजेंट कुछ भी निष्पादित नहीं करता। SAFE मोड से शुरू करें, और जब आप आश्वस्त हों तो YOLO में बदलें।

---

## तुलनात्मक विवरण

| सुविधा | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| फ़ोल्डर विश्वास मॉडल | ✅ | ❌ | ❌ | ❌ |
| अनुमति स्तर (SAFE → YOLO) | ✅ | ❌ | आंशिक | ❌ |
| **लाइव एक्ज़ीक्यूशन वॉटरफॉल ट्रेस और प्रोफाइलर** | ✅ | ❌ | ❌ | ❌ |
| **अंतर्निहित Cron शेड्यूलर** | ✅ | ❌ | ❌ | ❌ |
| **समानांतर सत्र और सब-एजेंट्स** | ✅ | ❌ | ❌ | आंशिक |
| इनलाइन नेटिव डिफ व्यूअर | ✅ | ✅ | ✅ | ✅ |
| सत्र प्रबंधन और `/undo` रोलबैक | ✅ | ❌ | आंशिक | ❌ |
| एजेंट प्रोफाइल (Profiles) | ✅ | ❌ | ❌ | आंशिक |
| स्थानीय प्राथमिकता / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| MCP प्रोटोकॉल समर्थन | ✅ | ❌ | आंशिक | ✅ |
| आधिकारिक VS Code एक्सटेंशन | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Cron शेड्यूलर — जब आप सो रहे हों तब काम करने वाला AI

किसी अन्य AI कोडिंग एजेंट में यह सुविधा नहीं है। Andromity के भीतर `/cron` खोलें, अपना कार्य लिखें, समय सारिणी निर्धारित करें — और एजेंट आपके दूर रहने पर भी टाइमर पर स्वायत्त रूप से कार्य निष्पादित करेगा।

```bash
# उदाहरण: हर रात 2 बजे टेस्ट सुइट चलाएं और असफल परीक्षणों को ठीक करके कमिट करें
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

जॉब्स प्रोजेक्ट के अनुसार `.andromity/crons.json` में सुरक्षित रहते हैं। पूरी तरह से स्वायत्त रातों-रात रन के लिए FULL या YOLO मोड का उपयोग करें।

---

## 🤖 समानांतर सत्र और सब-एजेंट्स

अपने मुख्य सत्र को बाधित किए बिना समानांतर कार्यप्रवाहों के लिए बैकग्राउंड सब-एजेंट्स बनाएं। उदाहरण: जब एक सब-एजेंट लाइब्रेरी पर शोध कर रहा हो, दूसरा कार्य कार्यान्वित कर रहा हो, और आप मुख्य सत्र में योजना की समीक्षा कर रहे हों — यह सब एक साथ संभव है।

```
मुख्य सत्र      → फीचर A की योजना और निर्माण
सब-एजेंट 1     → सर्वश्रेष्ठ ऑथेंटिकेशन लाइब्रेरी पर शोध
सब-एजेंट 2     → फीचर B के लिए यूनिट टेस्ट तैयार करना
```

`Ctrl+O` के साथ सभी सत्रों के बीच स्विच करें। प्रत्येक सत्र का अपना संदर्भ, इतिहास और फ़ाइल परिवर्तन लॉग होता है। `/undo` केवल वर्तमान सत्र के परिवर्तनों को वापस लेता है।

---

## टर्मिनल वर्कस्पेस की सुविधाएं

> VS Code एक्सटेंशन और टर्मिनल एक ही एजेंट कोर साझा करते हैं। टर्मिनल वर्कस्पेस आपको अधिकतम गति और नियंत्रण देता है।

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**प्रोफाइल (Profiles)।** सत्र के दौरान एजेंट के उद्देश्य को बदलें:
- `builder` — पहले योजना बनाता है, फिर कार्यान्वित करता है
- `coder` — बिना योजना के सीधे कोड लिखता है
- `reviewer` — केवल पढ़ने के लिए, ऑडिट और समीक्षा रिपोर्ट तैयार करता है
- `planner` — केवल आर्किटेक्चर योजना बनाता है, फाइलों को नहीं बदलता

**MCP समर्थन।** अपने प्रोजेक्ट में `mcp.json` जोड़ें। टूल स्कीमा ऑन-डिमांड लोड होते हैं — जिससे 50+ टूल कनेक्ट होने पर भी टोकन उपयोग न्यूनतम रहता है।

**सत्र (Sessions)।** सब कुछ सहेजा जाता है। बदलने के लिए `/sessions` या `Ctrl+O` का उपयोग करें। जब संदर्भ भारी हो जाए तो `/compact` करें। पिछले टर्न और उसके सभी फ़ाइल परिवर्तनों को वापस लेने के लिए `/undo` का उपयोग करें।

**हेडलेस / स्क्रिप्टेड रन:**
```bash
andromity run "auth.py में एरर हैंडलिंग जोड़ें"
andromity run "इसे async में रिफैक्टर करें" --yes      # सभी कार्यों को स्वतः स्वीकृत करें
andromity run "session.py की समीक्षा करें" --dry-run       # देखें कि यह क्या करेगा
```

**मॉडल-स्वतंत्र।** इसके मूल में LiteLLM है। Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM समर्थित हैं। `Ctrl+L` के साथ कभी भी बदलें।

---

## गोपनीयता और सुरक्षा

आपका कोड केवल आपके द्वारा कॉन्फ़िगर किए गए LLM प्रदाता के पास जाता है। हम आपका कोड कभी एकत्र नहीं करते।

- API कुंजियाँ स्थानीय रूप से `~/.andromity/config.toml` में एन्क्रिप्टेड रहती हैं
- सत्र स्थानीय रूप से `~/.andromity/sessions/` में संग्रहीत होते हैं
- टेलीमेट्री से बाहर निकलें: `export DO_NOT_TRACK=1`

---

## स्टार इतिहास (Star History)

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## अपडेट इतिहास

विस्तृत संस्करण विवरण के लिए [CHANGELOG.md](CHANGELOG.md) देखें।

---

## योगदान दें

इश्यू या पुल रिक्वेस्ट का स्वागत है!

प्रोजेक्ट संरचना और डेवलपमेंट सेटअप के लिए [CONTRIBUTING.md](CONTRIBUTING.md) देखें।

**MIT लाइसेंस** — [LICENSE](LICENSE) देखें।
