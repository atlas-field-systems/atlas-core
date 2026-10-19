package atlas

import (
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf8"
)

type Limits struct {
	MaxJSONBytes int
	MaxDepth     int
	MaxValues    int
	MaxFileBytes int64
}

func DefaultLimits() Limits { return Limits{1 << 20, 64, 100000, 2000000000} }

func (l Limits) check() error {
	if l.MaxJSONBytes < 1 || l.MaxDepth < 1 || l.MaxDepth > 256 || l.MaxValues < 1 || l.MaxFileBytes < 0 {
		return fmt.Errorf("invalid boundary limits")
	}
	return nil
}

type scanner struct {
	data     []byte
	i, count int
	limits   Limits
}

func scan(data []byte, limits Limits) error {
	if err := limits.check(); err != nil {
		return err
	}
	if len(data) > limits.MaxJSONBytes {
		return fmt.Errorf("payload_too_large")
	}
	if !utf8.Valid(data) {
		return fmt.Errorf("invalid_json: UTF-8")
	}
	s := scanner{data: data, limits: limits}
	if err := s.value(0); err != nil {
		return err
	}
	s.space()
	if s.i != len(data) {
		return fmt.Errorf("invalid_json: trailing values")
	}
	return nil
}
func (s *scanner) space() {
	for s.i < len(s.data) && (s.data[s.i] == ' ' || s.data[s.i] == '\n' || s.data[s.i] == '\r' || s.data[s.i] == '\t') {
		s.i++
	}
}
func (s *scanner) take(c byte) bool {
	s.space()
	if s.i < len(s.data) && s.data[s.i] == c {
		s.i++
		return true
	}
	return false
}
func (s *scanner) value(depth int) error {
	s.space()
	s.count++
	if depth > s.limits.MaxDepth || s.count > s.limits.MaxValues {
		return fmt.Errorf("invalid_json: work limit")
	}
	if s.i == len(s.data) {
		return fmt.Errorf("invalid_json: missing value")
	}
	switch s.data[s.i] {
	case '{':
		s.i++
		keys := map[string]struct{}{}
		if s.take('}') {
			return nil
		}
		for {
			s.count++
			if s.count > s.limits.MaxValues {
				return fmt.Errorf("invalid_json: work limit")
			}
			key, err := s.str()
			if err != nil {
				return err
			}
			if _, ok := keys[key]; ok {
				return fmt.Errorf("invalid_json: duplicate member %q", key)
			}
			keys[key] = struct{}{}
			if !s.take(':') {
				return fmt.Errorf("invalid_json: expected colon")
			}
			if err := s.value(depth + 1); err != nil {
				return err
			}
			if s.take('}') {
				return nil
			}
			if !s.take(',') {
				return fmt.Errorf("invalid_json: expected comma")
			}
		}
	case '[':
		s.i++
		if s.take(']') {
			return nil
		}
		for {
			if err := s.value(depth + 1); err != nil {
				return err
			}
			if s.take(']') {
				return nil
			}
			if !s.take(',') {
				return fmt.Errorf("invalid_json: expected comma")
			}
		}
	case '"':
		_, err := s.str()
		return err
	default:
		start := s.i
		for s.i < len(s.data) {
			c := s.data[s.i]
			if c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\r' || c == '\n' {
				break
			}
			s.i++
		}
		token := s.data[start:s.i]
		if string(token) == "true" || string(token) == "false" || string(token) == "null" {
			return nil
		}
		if len(token) == 0 || !json.Valid(token) {
			return fmt.Errorf("invalid_json: token")
		}
		if _, err := strconv.ParseFloat(string(token), 64); err != nil {
			return fmt.Errorf("invalid_json: nonfinite number")
		}
		return nil
	}
}
func (s *scanner) hex() (uint64, error) {
	if s.i+4 > len(s.data) {
		return 0, fmt.Errorf("invalid_json: Unicode escape")
	}
	n, err := strconv.ParseUint(string(s.data[s.i:s.i+4]), 16, 16)
	s.i += 4
	if err != nil {
		return 0, fmt.Errorf("invalid_json: Unicode escape")
	}
	return n, nil
}
func (s *scanner) str() (string, error) {
	s.space()
	start := s.i
	if s.i >= len(s.data) || s.data[s.i] != '"' {
		return "", fmt.Errorf("invalid_json: expected string")
	}
	s.i++
	for s.i < len(s.data) {
		c := s.data[s.i]
		s.i++
		if c == '"' {
			var value string
			err := json.Unmarshal(s.data[start:s.i], &value)
			return value, err
		}
		if c < 32 {
			return "", fmt.Errorf("invalid_json: control character")
		}
		if c != '\\' {
			continue
		}
		if s.i == len(s.data) {
			break
		}
		esc := s.data[s.i]
		s.i++
		if esc == 'u' {
			n, err := s.hex()
			if err != nil {
				return "", err
			}
			if n >= 0xDC00 && n <= 0xDFFF {
				return "", fmt.Errorf("invalid_json: lone surrogate")
			}
			if n >= 0xD800 && n <= 0xDBFF {
				if s.i+2 > len(s.data) || s.data[s.i] != '\\' || s.data[s.i+1] != 'u' {
					return "", fmt.Errorf("invalid_json: lone surrogate")
				}
				s.i += 2
				low, err := s.hex()
				if err != nil || low < 0xDC00 || low > 0xDFFF {
					return "", fmt.Errorf("invalid_json: lone surrogate")
				}
			}
		} else if esc != '"' && esc != '\\' && esc != '/' && esc != 'b' && esc != 'f' && esc != 'n' && esc != 'r' && esc != 't' {
			return "", fmt.Errorf("invalid_json: escape")
		}
	}
	return "", fmt.Errorf("invalid_json: unterminated string")
}
