---
title: How We Automate Grocery Lists for Market Day Baking
date: 2026-06-03
slug: automated-grocery-lists
author: William
excerpt: When a single market day means baking across five or six different recipes, the grocery list gets complicated fast. Here's how we built a system that turns a free-text bake plan into an organized shopping list in a matter of moments.
image: grocery-list-generation.jpg
hide_featured_image: true
meta_description: How 3pm German Baking uses custom automation to generate organized, department-sorted grocery lists from natural-language bake plans. A behind-the-scenes look at micro bakery operations in Asheville, NC.
---

## The Cart Problem

A single market day at 3pm German Baking means 100 to 120 slices across five or more different recipes. Before Mary ever preheats the oven, the ingredients have to get from the store to the kitchen.

When we started this business, I wanted to support Mary by handling the automation and operations side of things so she could focus on what drew her to baking in the first place. I have a decade of data science behind me, so building tools that make the business run smoothly is where I fit in. The grocery list system is one of those tools.

The grocery cart fills up fast. Pounds of butter. Bags of flour and sugar. Cartons of eggs. Quarts of yogurt. Whole vanilla beans, fresh lemons, spinach, frozen fruit. A full cart, every time, and every ingredient matters. Every trip has to be accurate.

## The Hidden Complexity

Multi-recipe grocery lists are deceptively hard to get right, and precision is where I build software to help.

The same ingredient appears across multiple recipes. If Mary is baking four Lemon Cakes, a Russian Pull Cake, and Spinach Tartlets, butter shows up in all of them. Sugar is in everything. Eggs are everywhere. Every amount has to be consolidated into a single shopping quantity with zero margin for error.

Then there is the store itself. Produce in one section, dairy in another, baking supplies somewhere else entirely. A flat list means crisscrossing the store six times, which is not how Mary wants to spend a Friday afternoon before a Saturday market.

## How It Works

The solution is a system that takes a free-text bake plan and turns it into an organized, department-sorted shopping list.

It works through Discord, a chat app we use to run our bakery's tools. Mary messages a small program on our Raspberry Pi (we call it Razi) with what she plans to bake, written in plain English, the way she would write a text message:

![Grocery list generation interface](/images/grocery-list-generation.jpg)

The system already knows the ingredient list for every recipe we bake, stored in standardized units down to the gram. When the bot receives a bake plan, it scales each recipe to the requested quantity, consolidates every ingredient across every recipe, and sorts the results by grocery store department: dairy together, produce together, baking aisle together. What could take an hour of hunting through recipe cards and doing arithmetic is effectively instantaneous.

The recipe data and calculations live in a Python application, not in a large language model (LLM). The math has to be right, every time. Ingredient consolidation, density-based measurements, department sorting—those are all deterministic. The LLM just translates Mary's free-text bake plan into something the calculator can understand. It is the glue, not the engine. If the system tells Mary to buy 12 sticks of butter, that number came from arithmetic, not from an LLM guessing what sounds plausible.

We kept our recipes digitized from the start for labeling and consistency. Once that foundation was in place, building a grocery list system on top of it was a natural next step. The whole thing runs on Razi in our house, always on, always ready to turn a text message into a shopping list.

## From Screen to Cart

The workflow is straightforward. Sometime before a market, Mary messages the bot on Discord with her bake plan. Right away she has an organized shopping list sorted by department. She prints it, heads to the store, and walks through once: dairy, produce, baking aisle, done. Fifteen to twenty minutes in and out, with a cart full of exactly what we need and nothing we do not.

The grocery run happens a day or two before the market, usually while Mary is wrapping up a batch of something delicious. It is one of the invisible pieces of running a micro bakery, the kind of thing nobody thinks about unless they have tried to do it themselves. Baking is what drew Mary to start the business. My goal with these tools is simple: handle everything I can on the technical side so she can spend her time on what matters most, baking and connecting with customers.

If you want to taste what all those grocery runs add up to, [find us at a market](/index.html#find-us) or [reach out directly](mailto:info@germanbakingasheville.com).
