package runtimecatalog

import "testing"

func TestBuiltinProjectionMatchesRegistryAndFiltersToMachineCatalog(t *testing.T) {
	if issues := ValidateBuiltinPiDefinitionProjection(); len(issues) > 0 {
		t.Fatalf("projection drift: %+v", issues)
	}
	if issues := ValidateKimiSDKDefinitionProjection(); len(issues) > 0 {
		t.Fatalf("kimi drift: %+v", issues)
	}
	if len(builtinPresetProviders) != 16 || builtinPresetProviders[0].ID != "deepseek" || builtinPresetProviders[0].Models[0].ID != "deepseek/deepseek-v4-pro" {
		t.Fatalf("preset registry drifted: %d %s", len(builtinPresetProviders), builtinPresetProviders[0].ID)
	}
	source, ok := BuildBuiltinPiFormOptionSource("provider")
	if !ok {
		t.Fatal("missing provider source")
	}
	filtered := FilterBuiltinPiFormOptionSource(source, map[string]struct{}{
		"deepseek/deepseek-v4-pro": {},
		"not-in-registry":          {},
	}).(SelectSource)
	got := map[string]string{}
	for _, option := range filtered.Options {
		got[option.Value] = option.ProviderKind
	}
	if got["deepseek"] != "preset" || got["openai-compatible"] != "gateway" || got["anthropic-compatible"] != "gateway" {
		t.Fatalf("providers = %#v", got)
	}
	if _, ok := got["openai"]; ok {
		t.Fatal("preset with no supported model must be removed")
	}
	if len(got) != 3 {
		t.Fatalf("unexpected providers %#v", got)
	}
	if filtered.Options[len(filtered.Options)-2].Label != "OpenAI Compatible" {
		t.Fatalf("gateway label = %q", filtered.Options[len(filtered.Options)-2].Label)
	}
	models, _ := BuildBuiltinPiFormOptionSource("model")
	modelSource := FilterBuiltinPiFormOptionSource(models, map[string]struct{}{
		"deepseek/deepseek-v4-pro": {},
		"not-in-registry":          {},
	}).(DependentSource)
	deepseek := modelSource.OptionsByValue["deepseek"]
	if len(deepseek) != 1 || deepseek[0].Value != "deepseek/deepseek-v4-pro" || modelSource.DefaultValueByValue["deepseek"] != "deepseek/deepseek-v4-pro" {
		t.Fatalf("deepseek models = %+v default %q", deepseek, modelSource.DefaultValueByValue["deepseek"])
	}
	if _, present := modelSource.OptionsByValue["openai"]; present {
		t.Fatal("openai models were kept without a supported id")
	}
	if len(modelSource.OptionsByValue["openai-compatible"]) != 0 || !modelSource.CustomValueAllowedByValue["openai-compatible"] {
		t.Fatal("gateway model policy changed")
	}

	kimi := BuildKimiSDKFormOptionSource([]ModelInfo{{
		ID: "kimi-code/kimi-for-coding", Label: "Kimi for Coding",
		SupportedReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: "low",
	}}, "kimi-code/kimi-for-coding")
	if kimi.DefaultValue != "kimi-code/kimi-for-coding" || len(kimi.Options) != 1 || kimi.Options[0].DefaultReasoningEffort != "low" {
		t.Fatalf("kimi source = %+v", kimi)
	}
}

func TestRequireBuiltinCatalogFailsClosedWithoutProof(t *testing.T) {
	daemon := "1.2.3"
	supported, err := RequireBuiltinCatalog(Outcome{Kind: "error", Retryable: true}, "m", &daemon, nil)
	if supported != nil || err == nil || err.Code != "builtin_catalog_unavailable" || err.Recovery != "retry" {
		t.Fatalf("unavailable = %#v %+v", supported, err)
	}
	_, err = RequireBuiltinCatalog(Outcome{Kind: "live", Value: &ModelSet{Models: []ModelInfo{{ID: "deepseek/deepseek-v4-pro", Label: "x"}}}}, "m", &daemon, nil)
	if err == nil || err.Code != "builtin_catalog_capability_required" || err.Recovery != "upgrade_required" {
		t.Fatalf("missing capability = %+v", err)
	}
	supported, err = RequireBuiltinCatalog(Outcome{Kind: "live", Value: &ModelSet{
		Models:  []ModelInfo{{ID: "deepseek/deepseek-v4-pro", Label: "DeepSeek V4 Pro"}},
		Catalog: &CatalogCapability{ProtocolVersion: 1, Runtime: "builtin", RuntimeVersion: "0.85.1"},
	}}, "m", &daemon, nil)
	if err != nil || len(supported) != 1 {
		t.Fatalf("supported = %#v err=%v", supported, err)
	}
}
