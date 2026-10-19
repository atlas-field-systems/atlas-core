package atlas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
)

// Places share their container links. A mark never copies its path from the root.
type numberPlace struct {
	children   map[string]*numberPlace
	start, end int
}

func (p *numberPlace) child(key string) *numberPlace {
	if p == nil {
		return nil
	}
	if p.children == nil {
		p.children = make(map[string]*numberPlace)
	}
	child := new(numberPlace)
	p.children[key] = child
	return child
}

type decimal struct {
	source                          string
	first, last, dot, digits, power int
	negative                        bool
}

func decimalOf(source string) decimal {
	d := decimal{source: source, first: -1, dot: -1, negative: source[0] == '-'}
	end := len(source)
	exp := strings.IndexAny(source, "eE")
	if exp >= 0 {
		end = exp
	}
	fractional, trailing := 0, 0
	for i := 0; i < end; i++ {
		c := source[i]
		if c == '.' {
			d.dot = i
			continue
		}
		if c == '-' {
			continue
		}
		if d.dot >= 0 {
			fractional++
		}
		if c != '0' {
			if d.first < 0 {
				d.first = i
			}
			d.last = i
			trailing = 0
		} else {
			trailing++
		}
	}
	if d.first < 0 {
		return decimal{source: source, first: -1}
	}
	d.digits = d.last - d.first + 1
	if d.dot > d.first && d.dot < d.last {
		d.digits--
	}
	if exp >= 0 {
		i := exp + 1
		neg := false
		if source[i] == '-' || source[i] == '+' {
			neg = source[i] == '-'
			i++
		}
		// A finite binary64 value has at most 309 integer digits. Include all coefficient shifts.
		cap := len(source) + 309 + 1
		for ; i < len(source); i++ {
			n := int(source[i] - '0')
			if d.power > (cap-n)/10 {
				d.power = cap
				break
			}
			d.power = d.power*10 + n
		}
		if neg {
			d.power = -d.power
		}
	}
	d.power += trailing - fractional
	return d
}
func (d decimal) digit(i int) byte {
	if i >= d.digits {
		return '0'
	}
	pos := d.first + i
	if d.dot >= d.first && pos >= d.dot {
		pos++
	}
	return d.source[pos]
}
func (d decimal) compare(other decimal) int {
	if d.first < 0 && other.first < 0 {
		return 0
	}
	if d.negative != other.negative {
		if d.negative {
			return -1
		}
		return 1
	}
	result := 0
	switch {
	case d.first < 0:
		result = -1
	case other.first < 0:
		result = 1
	case d.digits+d.power < other.digits+other.power:
		result = -1
	case d.digits+d.power > other.digits+other.power:
		result = 1
	default:
		for i := 0; i < max(d.digits, other.digits); i++ {
			if d.digit(i) < other.digit(i) {
				result = -1
				break
			}
			if d.digit(i) > other.digit(i) {
				result = 1
				break
			}
		}
	}
	if d.negative {
		return -result
	}
	return result
}
func (d decimal) integerSize() int {
	if d.first < 0 {
		return 1
	}
	size := d.digits + d.power
	if d.negative {
		size++
	}
	return size
}
func (d decimal) appendInteger(out []byte) []byte {
	if d.first < 0 {
		return append(out, '0')
	}
	if d.negative {
		out = append(out, '-')
	}
	for i := 0; i < d.digits; i++ {
		out = append(out, d.digit(i))
	}
	for i := 0; i < d.power; i++ {
		out = append(out, '0')
	}
	return out
}
func exactInteger(schema *openapi3.Schema, source json.Number) (decimal, error) {
	d := decimalOf(string(source))
	if d.first >= 0 && d.power < 0 {
		return d, fmt.Errorf("invalid_payload: noninteger")
	}
	bound := func(v float64) decimal { return decimalOf(strconv.FormatFloat(v, 'g', -1, 64)) }
	if schema.Min != nil {
		cmp := d.compare(bound(*schema.Min))
		if cmp < 0 || cmp == 0 && schema.ExclusiveMin.IsTrue() {
			return d, fmt.Errorf("invalid_payload: integer minimum")
		}
	}
	if schema.Max != nil {
		cmp := d.compare(bound(*schema.Max))
		if cmp > 0 || cmp == 0 && schema.ExclusiveMax.IsTrue() {
			return d, fmt.Errorf("invalid_payload: integer maximum")
		}
	}
	if v := schema.ExclusiveMin.Value; v != nil && d.compare(bound(*v)) <= 0 {
		return d, fmt.Errorf("invalid_payload: integer exclusive minimum")
	}
	if v := schema.ExclusiveMax.Value; v != nil && d.compare(bound(*v)) >= 0 {
		return d, fmt.Errorf("invalid_payload: integer exclusive maximum")
	}
	if len(schema.Enum) > 0 {
		found := false
		for _, v := range schema.Enum {
			if n, ok := v.(float64); ok && d.compare(bound(n)) == 0 {
				found = true
			}
		}
		if !found {
			return d, fmt.Errorf("invalid_payload: integer enum")
		}
	}
	return d, nil
}

type integerPlan map[*numberPlace]decimal

func (p integerPlan) merge(other integerPlan) {
	for place, d := range other {
		p[place] = d
	}
}
func (p integerPlan) wire(data []byte, limits Limits) ([]byte, error) {
	places := make([]*numberPlace, 0, len(p))
	size := len(data)
	for place := range p {
		size -= place.end - place.start
		places = append(places, place)
	}
	for _, d := range p {
		n := d.integerSize()
		if n > limits.MaxJSONBytes-size {
			return nil, fmt.Errorf("payload_too_large: canonical integers")
		}
		size += n
	}
	if len(p) == 0 {
		return data, nil
	}
	sort.Slice(places, func(i, j int) bool { return places[i].start < places[j].start })
	out := make([]byte, 0, size)
	start := 0
	for _, place := range places {
		out = append(out, data[start:place.start]...)
		out = p[place].appendInteger(out)
		start = place.end
	}
	return append(out, data[start:]...), nil
}
func (c *contract) checkJSON(name string, data []byte, limits Limits) ([]byte, error) {
	if err := scan(data, limits); err != nil {
		return nil, err
	}
	schema, ok := c.Components.Schemas[name]
	if !ok {
		return nil, fmt.Errorf("unknown schema %s", name)
	}
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	root := new(numberPlace)
	s := scanner{data: data, limits: limits}
	if err := s.value(0, root); err != nil {
		return nil, err
	}
	plan := make(integerPlan)
	if err := c.semantics(schema.Value, value, root, plan); err != nil {
		return nil, err
	}
	if err := c.branchSchemas[schema.Value].VisitJSON(value, c.formats); err != nil {
		return nil, err
	}
	return plan.wire(data, limits)
}
