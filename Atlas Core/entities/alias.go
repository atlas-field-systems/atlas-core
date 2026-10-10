package entities

import (
	"strings"
	"unicode"
)

// Every Alias comparison uses Unicode's locale-independent simple-fold cycle.
// Keep the original display value; only this private identity key is indexed.
func aliasKey(value string) string {
	return strings.Map(func(character rune) rune {
		key := character
		for folded := unicode.SimpleFold(character); folded != character; folded = unicode.SimpleFold(folded) {
			if folded < key {
				key = folded
			}
		}
		return key
	}, value)
}
