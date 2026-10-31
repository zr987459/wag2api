package mozjs

// SpiderMonkey 静态库冒烟测试：由 .github/workflows/spidermonkey.yml 复制进 AIStudio2API 的 internal/waa/mozjs 后编译运行。
// 在几组账户语言/时区下跑一段 BotGuard 常探测的标准 JS 能力（Intl、Date、正则 Unicode、WebAssembly、BigInt、Math），
// 输出到 $SM_SMOKE_OUT。原版和精简版各跑一次，workflow 逐行比对。

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
)

const smProbe = `(() => {
  const d = new Date(Date.UTC(2026, 0, 15, 12, 34, 56));
  const out = [];
  const t = (k, f) => { try { out.push(k + "=" + String(f())); } catch (e) { out.push(k + "=!" + e.name + ":" + e.message); } };
  t("dtf", () => JSON.stringify(Intl.DateTimeFormat().resolvedOptions()));
  t("nf", () => JSON.stringify(Intl.NumberFormat().resolvedOptions()));
  t("dateString", () => d.toString());
  t("toLocaleString", () => d.toLocaleString());
  t("toLocaleDate", () => d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
  t("tzOffset", () => d.getTimezoneOffset());
  t("tzName", () => new Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).format(d));
  t("num", () => (1234567.891).toLocaleString());
  t("currency", () => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(1234.5));
  t("unit", () => new Intl.NumberFormat(undefined, { style: "unit", unit: "kilobyte" }).format(12));
  t("compact", () => new Intl.NumberFormat(undefined, { notation: "compact" }).format(1234567));
  t("plural", () => new Intl.PluralRules().select(1) + "," + new Intl.PluralRules().select(2));
  t("rtf", () => new Intl.RelativeTimeFormat().format(-1, "day"));
  t("list", () => new Intl.ListFormat().format(["a", "b", "c"]));
  t("displayRegion", () => new Intl.DisplayNames(undefined, { type: "region" }).of("US"));
  t("displayLang", () => new Intl.DisplayNames(undefined, { type: "language" }).of("fr"));
  t("segmenter", () => [...new Intl.Segmenter().segment("hello world")].length);
  t("collator", () => ["b", "a", "\u00e4", "Z"].sort(new Intl.Collator().compare).join());
  t("supported", () => Intl.DateTimeFormat.supportedLocalesOf(["en-US", "zh-CN", "ja-JP", "de-DE", "ru-RU", "ar-EG", "sw-KE", "bn-BD"]).join());
  t("valuesOfTZ", () => Intl.supportedValuesOf("timeZone").length);
  t("valuesOfCur", () => Intl.supportedValuesOf("currency").length);
  t("locale", () => new Intl.Locale("zh-Hant-TW").maximize().toString());
  t("normalize", () => "A\u030A".normalize("NFC").length);
  t("regexProp", () => /\p{Script=Han}/u.test("\u4e2d") + "," + /\p{L}+/v.test("abc"));
  t("caseMap", () => "\u00df".toUpperCase() + "\u0130".toLowerCase().length);
  t("wasm", () => typeof WebAssembly + "," + WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  t("temporal", () => typeof Temporal);
  t("bigint", () => (2n ** 64n).toString());
  t("math", () => [Math.sin(1), Math.exp(1), Math.tan(-1e300), Math.cbrt(7)].join());
  t("json", () => JSON.stringify({ a: [1, "x", null] }));
  t("proxyReflect", () => Reflect.ownKeys(new Proxy({ b: 1 }, {})).join());
  t("errorStack", () => typeof new Error().stack);
  t("features", () => ["Atomics", "SharedArrayBuffer", "WeakRef", "FinalizationRegistry", "Iterator", "AsyncIterator", "Float16Array"].map(n => n + ":" + typeof globalThis[n]).join(" "));
  let s = 0; for (let i = 0; i < 2e6; i++) s = (s + i * 31) % 1000003;
  t("loop", () => s);
  return out.join("\n");
})()`

func TestSpiderMonkeyLiteSmoke(t *testing.T) {
	cases := []struct{ locale, zone string }{
		{"en-US", "America/Los_Angeles"},
		{"zh-CN", "Asia/Shanghai"},
		{"ja-JP", "Asia/Tokyo"},
		{"de-DE", "Europe/Berlin"},
		{"ru-RU", "Europe/Moscow"},
		{"pt-BR", "America/Sao_Paulo"},
		{"ar-EG", "Africa/Cairo"},
		{"sw-KE", "Africa/Nairobi"},
	}
	var report strings.Builder
	for _, c := range cases {
		done := make(chan string, 1)
		go func(locale, zone string) {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			lang, region, _ := strings.Cut(locale, "-")
			SetCamouLocale(strings.ToLower(lang), strings.ToUpper(region), locale)
			cx, err := NewContext(Options{HeapBytes: 256 << 20, Locale: locale})
			if err != nil {
				done <- "ERROR " + err.Error()
				return
			}
			defer cx.Close()
			global, err := cx.NewGlobal(0, zone)
			if err != nil {
				done <- "ERROR " + err.Error()
				return
			}
			value, err := cx.Evaluate(global, smProbe, "https://www.google.com/js/bg/smoke.js", 1)
			if err != nil {
				done <- "ERROR " + err.Error()
				return
			}
			done <- value.String
		}(c.locale, c.zone)
		result := <-done
		for _, line := range strings.Split(result, "\n") {
			fmt.Fprintf(&report, "%s|%s\n", c.locale, line)
		}
	}
	fmt.Print(report.String())
	if path := os.Getenv("SM_SMOKE_OUT"); path != "" {
		if err := os.WriteFile(path, []byte(report.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Contains(report.String(), "|ERROR ") {
		t.Fatal("SpiderMonkey 冒烟测试出错")
	}
}
