package com.example.demo.controllers;

import java.util.List;

import javax.servlet.http.HttpSession;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

import com.example.demo.model.User;
import com.example.demo.service.CheckProfile;

@Controller
public class StaffController {

	@Autowired
	private CheckProfile checkProfile;

	@GetMapping("/staff")
	public String staffHome(ModelMap model, HttpSession session) {
		model.put("username", session.getAttribute("username"));
		model.put("role", session.getAttribute("role"));
		return "home-staff";
	}

	@GetMapping("/showcust")
	public String showCustomers(@RequestParam(required = false) String username, ModelMap model,
			HttpSession session) {
		List<User> customers = checkProfile.getCustomers(username);
		model.put("allcust", customers);
		model.put("username", session.getAttribute("username"));
		model.put("role", session.getAttribute("role"));
		model.put("searchUsername", username == null ? "" : username);
		model.put("notFound", username != null && !username.trim().isEmpty() && customers.isEmpty());
		return "showcust";
	}
}
