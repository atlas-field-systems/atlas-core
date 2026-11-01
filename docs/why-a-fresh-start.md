# Why we are starting fresh

Atlas has been rebuilt several times across earlier repositories. During this
build, the documentation became too long for the project owner to keep reading.
Some planning changes then carried the system away from the owner's intended
simple model.

AI makes implementation fast. The owner still needs to understand and review
the behavior being built. A fresh repository gives us a planning-first starting
point, with documentation that is readable from the beginning.

## The working rule

The project owner must be able to read the documentation whenever it changes.

- Start with a concrete user story and a short data flow.
- Make behavior and system boundaries visible at a glance.
- Keep field definitions and implementation details in optional reference.
- Show open questions separately from agreed decisions.
- Review a changed story before implementing changed behavior.

The [system pages](README.md#the-four-systems) are the starting point for that review.
Useful existing decisions remain available without making the entire old design
the specification for the next version.

## What happens to this repository

The intended next step is a fresh repository built from reviewed planning docs.
The existing implementation is retained here while that planning happens.
Archiving or deleting this repository, renaming it, and reusing its URL remain
separate actions. This documentation change performs none of them.
