// Small regexp indirection so handler files stay focused on HTTP logic.
package legacyweb

import "regexp"

type regexpWrapper struct{ re *regexp.Regexp }

func compileRegexp(expr string) *regexpWrapper {
	return &regexpWrapper{re: regexp.MustCompile(expr)}
}

func (w *regexpWrapper) MatchString(s string) bool { return w.re.MatchString(s) }
